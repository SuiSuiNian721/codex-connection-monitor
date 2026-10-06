#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace {

std::wstring EnvironmentValue(const wchar_t* name) {
    const DWORD length = GetEnvironmentVariableW(name, nullptr, 0);
    if (length == 0) return {};
    std::vector<wchar_t> buffer(length);
    if (GetEnvironmentVariableW(name, buffer.data(), length) == 0) return {};
    return std::wstring(buffer.data());
}

bool IsAbsoluteFile(const std::wstring& value) {
    const bool absolute = (value.size() >= 3 && value[1] == L':' && (value[2] == L'\\' || value[2] == L'/')) ||
                          (value.size() >= 2 && value[0] == L'\\' && value[1] == L'\\');
    const DWORD attributes = GetFileAttributesW(value.c_str());
    return absolute && attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

// Windows CRT 参数规则：引号前和字符串末尾的反斜杠必须分别加倍。
std::wstring QuoteArgument(const std::wstring& argument) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (const wchar_t character : argument) {
        if (character == L'\\') { ++slashes; continue; }
        if (character == L'\"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0;
        result.push_back(character);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

HANDLE InheritedStandardHandle(DWORD identifier, DWORD access) {
    HANDLE original = GetStdHandle(identifier);
    HANDLE copy = INVALID_HANDLE_VALUE;
    if (original != nullptr && original != INVALID_HANDLE_VALUE &&
        DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return copy;
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
}

void WriteError(const char* message) {
    const HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
    DWORD written = 0;
    WriteFile(error, message, static_cast<DWORD>(std::strlen(message)), &written, nullptr);
}

int Fail(const char* message) {
    WriteError(message);
    return 2;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
    const std::wstring node = EnvironmentValue(L"CODEX_GENERATION_NODE");
    const std::wstring script = EnvironmentValue(L"CODEX_GENERATION_SCRIPT");
    const std::wstring realCli = EnvironmentValue(L"CODEX_GENERATION_REAL_CLI");
    if (!IsAbsoluteFile(node) || !IsAbsoluteFile(script) || !IsAbsoluteFile(realCli)) {
        return Fail("Codex generation bridge: invalid local executable configuration.\n");
    }
    std::wstring command = QuoteArgument(node) + L" " + QuoteArgument(script);
    for (int index = 1; index < argc; ++index) command += L" " + QuoteArgument(argv[index]);
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');

    HANDLE handles[3] = {
        InheritedStandardHandle(STD_INPUT_HANDLE, GENERIC_READ),
        InheritedStandardHandle(STD_OUTPUT_HANDLE, GENERIC_WRITE),
        InheritedStandardHandle(STD_ERROR_HANDLE, GENERIC_WRITE),
    };
    for (const HANDLE handle : handles) {
        if (handle == INVALID_HANDLE_VALUE) {
            for (const HANDLE opened : handles) if (opened != INVALID_HANDLE_VALUE) CloseHandle(opened);
            return Fail("Codex generation bridge: standard handle forwarding failed.\n");
        }
    }

    SIZE_T attributeSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    std::vector<unsigned char> attributeMemory(attributeSize);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeMemory.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize) ||
        !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)) {
        for (const HANDLE handle : handles) CloseHandle(handle);
        return Fail("Codex generation bridge: handle inheritance configuration failed.\n");
    }

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == nullptr || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        if (job != nullptr) CloseHandle(job);
        DeleteProcThreadAttributeList(attributes);
        for (const HANDLE handle : handles) CloseHandle(handle);
        return Fail("Codex generation bridge: process cleanup configuration failed.\n");
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION child{};
    const BOOL created = CreateProcessW(node.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
                                       EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr,
                                       &startup.StartupInfo, &child);
    DeleteProcThreadAttributeList(attributes);
    for (const HANDLE handle : handles) CloseHandle(handle);
    if (!created) {
        CloseHandle(job);
        return Fail("Codex generation bridge: local Node launch failed.\n");
    }
    if (!AssignProcessToJobObject(job, child.hProcess)) {
        TerminateProcess(child.hProcess, 2);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return Fail("Codex generation bridge: child process cleanup binding failed.\n");
    }
    ResumeThread(child.hThread);
    CloseHandle(child.hThread);
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD exitCode = 2;
    GetExitCodeProcess(child.hProcess, &exitCode);
    CloseHandle(child.hProcess);
    // 正常 CLI 退出应保留它有意启动的后台工具；只有 shim 被中断时
    // 才由仍设置 KILL_ON_JOB_CLOSE 的私有 Job 清理整个通信子进程组。
    limits.BasicLimitInformation.LimitFlags = 0;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        WriteError("Codex generation bridge: normal process cleanup flag reset failed.\n");
    }
    CloseHandle(job);
    return static_cast<int>(exitCode);
}
