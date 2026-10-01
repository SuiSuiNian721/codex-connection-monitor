using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CodexLauncher
{
    // Stream copying avoids copying EFS attributes from WindowsApps. Workers never invoke PowerShell.
    public sealed class CuaCopyJob : IDisposable
    {
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private int completed;
        public int CompletedFiles { get { return Volatile.Read(ref completed); } }
        public Task Work { get; private set; }

        public CuaCopyJob(string source, string destination, string[] files)
        {
            Work = Task.Run(() => Parallel.ForEach(files,
                new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = cancellation.Token },
                relative =>
                {
                    string input = Path.Combine(source, relative);
                    string output = Path.Combine(destination, relative);
                    AssertNoReparse(input);
                    AssertNoReparse(Path.GetDirectoryName(output));
                    byte[] sourceHash;
                    using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                    using (var reader = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read, 131072, FileOptions.SequentialScan))
                    {
                        using (var writer = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 131072, FileOptions.SequentialScan))
                        {
                            byte[] buffer = new byte[131072];
                            int length;
                            while ((length = reader.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                cancellation.Token.ThrowIfCancellationRequested();
                                writer.Write(buffer, 0, length);
                                hash.AppendData(buffer, 0, length);
                            }
                            writer.Flush(true);
                        }
                        sourceHash = hash.GetHashAndReset();
                    }
                    if (!EqualHash(sourceHash, Hash(output)))
                        throw new IOException("CUA copy verification failed: " + relative);
                    Interlocked.Increment(ref completed);
                }));
        }

        public static void AssertNoReparse(string path)
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("CUA reparse link is not supported: " + path);
        }

        private static byte[] Hash(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var hash = SHA256.Create())
                return hash.ComputeHash(stream);
        }

        private static bool EqualHash(byte[] left, byte[] right)
        {
            if (left.Length != right.Length) return false;
            for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
            return true;
        }

        private static string InventorySignature(string root, string[] files, string[] directories)
        {
            var expectedFiles = new HashSet<string>(files, StringComparer.OrdinalIgnoreCase);
            var expectedDirectories = new HashSet<string>(directories, StringComparer.OrdinalIgnoreCase);
            var pending = new Stack<string>();
            var entries = new List<string>();
            AssertNoReparse(root);
            pending.Push(root);
            while (pending.Count > 0)
            {
                foreach (FileSystemInfo item in new DirectoryInfo(pending.Pop()).EnumerateFileSystemInfos())
                {
                    if ((item.Attributes & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("CUA reparse link is not supported: " + item.FullName);
                    string relative = Path.GetRelativePath(root, item.FullName);
                    if (item is DirectoryInfo)
                    {
                        if (!expectedDirectories.Remove(relative)) return null;
                        pending.Push(item.FullName);
                        entries.Add("D\0" + relative);
                    }
                    else
                    {
                        if (!expectedFiles.Remove(relative)) return null;
                        entries.Add("F\0" + relative + "\0" + ((FileInfo)item).Length + "\0" + item.LastWriteTimeUtc.Ticks + "\0" + item.CreationTimeUtc.Ticks);
                    }
                }
            }
            if (expectedFiles.Count != 0 || expectedDirectories.Count != 0) return null;
            entries.Sort(StringComparer.Ordinal);
            using (var hash = SHA256.Create())
                return Convert.ToHexString(hash.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", entries))));
        }

        public static string MetadataSignature(string source, string destination, string[] files, string[] directories)
        {
            try
            {
                string left = InventorySignature(source, files, directories);
                string right = InventorySignature(destination, files, directories);
                return left == null || right == null ? null : left + right;
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }

        public static bool Matches(string source, string destination, string[] files, string[] directories)
        {
            try
            {
                if (MetadataSignature(source, destination, files, directories) == null) return false;
                int valid = 1;
                Parallel.ForEach(files, new ParallelOptions { MaxDegreeOfParallelism = 4 }, (relative, state) =>
                    {
                        bool match = false;
                        try
                        {
                            string input = Path.Combine(source, relative);
                            string output = Path.Combine(destination, relative);
                            AssertNoReparse(input);
                            AssertNoReparse(output);
                            match = new FileInfo(input).Length == new FileInfo(output).Length && EqualHash(Hash(input), Hash(output));
                        }
                        catch (IOException) { }
                        catch (UnauthorizedAccessException) { }
                        if (!match) { Interlocked.Exchange(ref valid, 0); state.Stop(); }
                    });
                return valid == 1;
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        public void Dispose()
        {
            cancellation.Cancel();
            // Finish/cancel workers before the caller cleans up its own staging directory.
            try { Work.GetAwaiter().GetResult(); } catch { }
            cancellation.Dispose();
        }
    }
}
