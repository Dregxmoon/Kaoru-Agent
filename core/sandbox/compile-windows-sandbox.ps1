param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace KaoruSandbox
{
    internal static class Native
    {
        internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        internal const uint CREATE_NO_WINDOW = 0x08000000;
        internal const uint CREATE_SUSPENDED = 0x00000004;
        internal const uint STARTF_USESTDHANDLES = 0x00000100;
        internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        internal const int JobObjectExtendedLimitInformation = 9;
        internal const uint WAIT_TIMEOUT = 0x00000102;
        internal const uint INFINITE = 0xffffffff;
        internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES =
            new IntPtr(0x00020009);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct STARTUPINFO
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal uint dwX;
            internal uint dwY;
            internal uint dwXSize;
            internal uint dwYSize;
            internal uint dwXCountChars;
            internal uint dwYCountChars;
            internal uint dwFillAttribute;
            internal uint dwFlags;
            internal short wShowWindow;
            internal short cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct STARTUPINFOEX
        {
            internal STARTUPINFO StartupInfo;
            internal IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROCESS_INFORMATION
        {
            internal IntPtr hProcess;
            internal IntPtr hThread;
            internal uint dwProcessId;
            internal uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_CAPABILITIES
        {
            internal IntPtr AppContainerSid;
            internal IntPtr Capabilities;
            internal uint CapabilityCount;
            internal uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int CreateAppContainerProfile(
            string appContainerName,
            string displayName,
            string description,
            IntPtr capabilities,
            uint capabilityCount,
            out IntPtr appContainerSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int DeriveAppContainerSidFromAppContainerName(
            string appContainerName,
            out IntPtr appContainerSid);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            int flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            [In] ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetInformationJobObject(
            IntPtr job,
            int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
            uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll")]
        internal static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern IntPtr FreeSid(IntPtr sid);
    }

    internal sealed class AppContainerProfile : IDisposable
    {
        internal IntPtr Sid { get; private set; }

        internal AppContainerProfile(string name, string workspace)
        {
            IntPtr sid;
            int hr = Native.CreateAppContainerProfile(
                name,
                "Kaoru Agent tool sandbox",
                "Isolated commands launched by Kaoru Agent",
                IntPtr.Zero,
                0,
                out sid);

            const int AlreadyExists = unchecked((int)0x800700B7);
            if (hr == AlreadyExists)
                hr = Native.DeriveAppContainerSidFromAppContainerName(name, out sid);
            if (hr < 0)
                Marshal.ThrowExceptionForHR(hr);

            Sid = sid;
            GrantWorkspaceAccess(workspace, new SecurityIdentifier(sid));
        }

        private static void GrantWorkspaceAccess(string workspace, SecurityIdentifier sid)
        {
            string fullPath = Path.GetFullPath(workspace);
            if (!Directory.Exists(fullPath))
                throw new DirectoryNotFoundException("Workspace not found: " + fullPath);

            DirectorySecurity security = Directory.GetAccessControl(fullPath);
            FileSystemAccessRule rule = new FileSystemAccessRule(
                sid,
                FileSystemRights.Modify | FileSystemRights.ReadAndExecute |
                    FileSystemRights.ListDirectory | FileSystemRights.Read | FileSystemRights.Write,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow);
            security.SetAccessRule(rule);
            Directory.SetAccessControl(fullPath, security);
        }

        public void Dispose()
        {
            if (Sid != IntPtr.Zero)
            {
                Native.FreeSid(Sid);
                Sid = IntPtr.Zero;
            }
        }
    }

    public static class Program
    {
        private static string Decode(string value)
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value));
        }

        private static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
                return arg;

            StringBuilder output = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char ch in arg)
            {
                if (ch == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (ch == '"')
                {
                    output.Append('\\', backslashes * 2 + 1);
                    output.Append(ch);
                    backslashes = 0;
                    continue;
                }
                output.Append('\\', backslashes);
                backslashes = 0;
                output.Append(ch);
            }
            output.Append('\\', backslashes * 2);
            output.Append('"');
            return output.ToString();
        }

        private static Dictionary<string, string> ParseOptions(string[] args, out int commandIndex)
        {
            Dictionary<string, string> options = new Dictionary<string, string>();
            commandIndex = -1;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--")
                {
                    commandIndex = i + 1;
                    break;
                }
                if (!args[i].StartsWith("--") || i + 1 >= args.Length)
                    throw new ArgumentException("Invalid launcher arguments");
                options[args[i]] = args[++i];
            }
            return options;
        }

        public static int Main(string[] args)
        {
            Native.PROCESS_INFORMATION process = new Native.PROCESS_INFORMATION();
            IntPtr attributeList = IntPtr.Zero;
            IntPtr capabilitiesBuffer = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            try
            {
                int commandIndex;
                Dictionary<string, string> options = ParseOptions(args, out commandIndex);
                if (commandIndex < 0 || commandIndex >= args.Length)
                    throw new ArgumentException("Missing command");

                string profileName = options["--profile"];
                string workspace = Decode(options["--workspace64"]);
                string cwd = Decode(options["--cwd64"]);
                uint timeout = UInt32.Parse(options["--timeout"]);
                string fullWorkspace = Path.GetFullPath(workspace).TrimEnd(Path.DirectorySeparatorChar) +
                    Path.DirectorySeparatorChar;
                string fullCwd = Path.GetFullPath(cwd);
                if (!fullCwd.Equals(fullWorkspace.TrimEnd(Path.DirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase) &&
                    !fullCwd.StartsWith(fullWorkspace, StringComparison.OrdinalIgnoreCase))
                    throw new UnauthorizedAccessException("Working directory is outside workspace");

                List<string> command = new List<string>();
                for (int i = commandIndex; i < args.Length; i++) command.Add(Decode(args[i]));
                if (command.Count == 0) throw new ArgumentException("Empty command");

                using (AppContainerProfile profile = new AppContainerProfile(profileName, workspace))
                {
                    IntPtr attributeSize = IntPtr.Zero;
                    Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                    attributeList = Marshal.AllocHGlobal(attributeSize);
                    if (!Native.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                    Native.SECURITY_CAPABILITIES capabilities = new Native.SECURITY_CAPABILITIES();
                    capabilities.AppContainerSid = profile.Sid;
                    capabilitiesBuffer = Marshal.AllocHGlobal(
                        Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES)));
                    Marshal.StructureToPtr(capabilities, capabilitiesBuffer, false);
                    if (!Native.UpdateProcThreadAttribute(
                        attributeList,
                        0,
                        Native.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                        capabilitiesBuffer,
                        new IntPtr(Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES))),
                        IntPtr.Zero,
                        IntPtr.Zero))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                    Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
                    startup.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
                    startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                    startup.StartupInfo.hStdInput = Native.GetStdHandle(-10);
                    startup.StartupInfo.hStdOutput = Native.GetStdHandle(-11);
                    startup.StartupInfo.hStdError = Native.GetStdHandle(-12);
                    startup.lpAttributeList = attributeList;

                    StringBuilder commandLine = new StringBuilder();
                    for (int i = 0; i < command.Count; i++)
                    {
                        if (i > 0) commandLine.Append(' ');
                        commandLine.Append(Quote(command[i]));
                    }

                    job = Native.CreateJobObject(IntPtr.Zero, null);
                    if (job == IntPtr.Zero)
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                        new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    if (!Native.SetInformationJobObject(
                        job,
                        Native.JobObjectExtendedLimitInformation,
                        ref limits,
                        (uint)Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                    uint flags = Native.EXTENDED_STARTUPINFO_PRESENT |
                        Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW |
                        Native.CREATE_SUSPENDED;
                    if (!Native.CreateProcess(
                        null,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        flags,
                        IntPtr.Zero,
                        fullCwd,
                        ref startup,
                        out process))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                    if (!Native.AssignProcessToJobObject(job, process.hProcess))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    if (Native.ResumeThread(process.hThread) == UInt32.MaxValue)
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                    uint wait = Native.WaitForSingleObject(process.hProcess, timeout);
                    if (wait == Native.WAIT_TIMEOUT)
                    {
                        Native.TerminateJobObject(job, 124);
                        Console.Error.WriteLine("Kaoru AppContainer: command timed out");
                        return 124;
                    }
                    uint exitCode;
                    if (!Native.GetExitCodeProcess(process.hProcess, out exitCode))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    return unchecked((int)exitCode);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Kaoru AppContainer: " + ex.Message);
                return 125;
            }
            finally
            {
                if (process.hThread != IntPtr.Zero) Native.CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) Native.CloseHandle(process.hProcess);
                if (job != IntPtr.Zero) Native.CloseHandle(job);
                if (attributeList != IntPtr.Zero)
                {
                    Native.DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (capabilitiesBuffer != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesBuffer);
            }
        }
    }
}
'@

$outputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
if (Test-Path -LiteralPath $OutputPath) {
  Remove-Item -LiteralPath $OutputPath -Force
}

Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $OutputPath `
  -OutputType ConsoleApplication
