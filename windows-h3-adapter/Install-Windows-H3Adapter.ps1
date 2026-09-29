#Requires -Version 5.1
<######################################################################
Install only the verified H3 8790 adapter source baseline. This script does
not create an owner config, start services, download models, or touch media.
######################################################################>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiRoot,
    [string]$PythonExe = 'python.exe',
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# These are SHA-256 values of UTF-8 source bytes with CRLF normalized to LF.
# Only line-ending differences are allowed; changed H3 code is a new baseline.
$baseline = [ordered]@{
    'workbench\workbench_node.py' = '3de09c917e31889dd99cc7f3c9d4cc7cd598b7a29f8afd5ab6764e81020aaded'
    'workbench\graphs.py' = '8656fe93fb2be83bbf68a867d3fae2420a86f00ab43ca9f0c997c76d79c8c858'
    'local_h3\comfy.py' = 'c8551d56d875ee7dde0e210e60a5441e11ce638745cbfddd8afb30f384a7576f'
    'local_h3\app.py' = '4266bebd00359281878e3297dba79e6115deb88374a77fd10dacda3db65a2f51'
    'local_h3\jobs.py' = '37bec7ac1b7408ff7c13d211f58a715e9ee5535bc0df60723a16c40e1b2767d1'
    'local_h3\schemas.py' = '981ba2dee2679d75e0cef7f492a2d1b4a2a83498bc6144f971b978ed67a64aa7'
    'local_h3\workflows.py' = '24981a021e5cfe4ca42e5a11736424d0b5f7d632f8ec207bd7ab5b4a9ee93900'
}
$installedNodeHash = '0650d18bc9060efda379185944ef6841a0dcae5ce0ed3cec24076fefd512a2f2'
$bundle = [ordered]@{
    'workbench_node.identity.patch' = 'c16bbcf9fc93e7a74158ebd6b9ed649009c280e20750e87d3ad14673702cd47b'
    'recipe_identity.py' = 'b5b8d8e3966ab41b8cfbe1584106af3fc75e98dbd04e92f73c7dc24bf423ff3d'
    'runtime_attestation.py' = '8a62cd1e7d91f2985cffa91bff4a1bab9447d816be6473f155c0360152a88286'
}

function Get-NormalizedBytesSha256([byte[]]$Bytes, [string]$Label) {
    $normalized = New-Object System.IO.MemoryStream
    try {
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            if ($bytes[$i] -eq 13) {
                if ($i + 1 -ge $bytes.Length -or $bytes[$i + 1] -ne 10) {
                    throw "文件含有非 CRLF 的回车字符，拒绝安装：$Label"
                }
                continue
            }
            $normalized.WriteByte($bytes[$i])
        }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [System.BitConverter]::ToString($sha.ComputeHash($normalized.ToArray())).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    } finally {
        $normalized.Dispose()
    }
}

function Convert-ToLfBytes([byte[]]$Bytes, [string]$Label) {
    $normalized = New-Object System.IO.MemoryStream
    try {
        for ($i = 0; $i -lt $Bytes.Length; $i++) {
            if ($Bytes[$i] -eq 13) {
                if ($i + 1 -ge $Bytes.Length -or $Bytes[$i + 1] -ne 10) {
                    throw "文件含有非 CRLF 的回车字符，拒绝安装：$Label"
                }
                continue
            }
            $normalized.WriteByte($Bytes[$i])
        }
        return ,$normalized.ToArray()
    } finally {
        $normalized.Dispose()
    }
}

function Stop-BinaryChild([System.Diagnostics.Process]$Process) {
    # A child may exit between HasExited and Kill. Cleanup must never hide the
    # original git/stdin error or leave an indefinite WaitForExit behind.
    try {
        if (-not $Process.HasExited) { $Process.Kill() }
    } catch { }
    try { $Process.WaitForExit(5000) | Out-Null } catch { }
    try { return $Process.HasExited } catch { return $false }
}

function Invoke-BinaryStdinProcess([string]$Exe, [string]$Directory,
                                   [string]$Arguments, [byte[]]$InputBytes,
                                   [string]$Label) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Exe
    $start.WorkingDirectory = $Directory
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    $started = $false
    try {
        if (-not $process.Start()) { throw "无法启动 $Label 进程。" }
        $started = $true
        # Drain both pipes before sending any bytes, including failure output.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $writeError = $null
        try {
            # StreamWriter can recode a patch; BaseStream preserves pinned bytes.
            # A bounded async write also handles a child that never reads stdin.
            $writeTask = $process.StandardInput.BaseStream.WriteAsync($InputBytes, 0, $InputBytes.Length)
            if (-not $writeTask.Wait(120000)) {
                $writeError = '二进制 stdin 写入超时'
                if (-not (Stop-BinaryChild $process)) {
                    $writeError += '，子进程未能停止'
                }
            } else {
                $null = $writeTask.GetAwaiter().GetResult()
            }
        } catch {
            $writeError = $_.Exception.Message
        } finally {
            try {
                $process.StandardInput.Close()
            } catch {
                if (-not $writeError) { $writeError = $_.Exception.Message }
            }
        }
        $timedOut = -not $process.WaitForExit(120000)
        if ($timedOut) {
            if (-not (Stop-BinaryChild $process)) {
                throw "$Label 进程超时，且子进程未能停止。"
            }
        }
        $exitCode = $process.ExitCode
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($timedOut) { throw "$Label 进程超时并已停止（exit $exitCode）。" }
        if ($writeError) {
            throw "$Label 字节写入失败（exit $exitCode）：$writeError；$stderr"
        }
        return [pscustomobject]@{ ExitCode = $exitCode; Stdout = $stdout; Stderr = $stderr }
    } finally {
        if ($started) { Stop-BinaryChild $process | Out-Null }
        $process.Dispose()
    }
}

function Invoke-GitApplyPatch([string]$GitExe, [string]$Directory,
                              [byte[]]$PatchBytes, [bool]$CheckOnly) {
    $arguments = if ($CheckOnly) {
        'apply --check --whitespace=nowarn -- -'
    } else {
        'apply --whitespace=nowarn -- -'
    }
    return Invoke-BinaryStdinProcess $GitExe $Directory $arguments $PatchBytes 'Git 补丁'
}

function Get-NormalizedSha256([string]$Path) {
    return Get-NormalizedBytesSha256 ([System.IO.File]::ReadAllBytes($Path)) $Path
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "缺少 $Label；此 H3 基线不兼容，未改动文件。"
    }
    Assert-NoReparsePoint $Path $Label
    $actual = Get-NormalizedSha256 $Path
    if ($actual -ne $Expected) {
        throw "$Label 的源码摘要与支持的基线不符（当前 $actual）；拒绝强制补丁，未改动文件。"
    }
}

function Get-RawSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Read-StreamBytes([System.IO.FileStream]$Stream) {
    $Stream.Position = 0
    $memory = New-Object System.IO.MemoryStream
    try {
        $Stream.CopyTo($memory)
        return ,$memory.ToArray()
    } finally {
        $memory.Dispose()
    }
}

function Write-StreamBytes([System.IO.FileStream]$Stream, [byte[]]$Bytes) {
    $Stream.Position = 0
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.SetLength($Bytes.Length)
    $Stream.Flush($true)
}

function Ensure-NativeFileHandleType {
    if (([System.Management.Automation.PSTypeName]'QianshouH3NativeFileHandle').Type) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class QianshouH3NativeFileHandle {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfo {
        [MarshalAs(UnmanagedType.U1)] public bool DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int fileInfoClass, out FileAttributeTagInfo info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
        out ByHandleFileInformation info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle,
        int fileInfoClass, ref FileDispositionInfo info, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,
        StringBuilder path, uint capacity, uint flags);

    public static string PhysicalPath(SafeFileHandle handle) {
        const uint VOLUME_NAME_GUID = 1;
        StringBuilder path = new StringBuilder(512);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, VOLUME_NAME_GUID);
        if (length == 0) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
        if (length >= path.Capacity) {
            path = new StringBuilder(checked((int)length + 1));
            length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, VOLUME_NAME_GUID);
            if (length == 0 || length >= path.Capacity) {
                throw new IOException("无法稳定读取文件的物理路径；拒绝修改。");
            }
        }
        return path.ToString().TrimEnd('\\');
    }

    private static void CheckAttributes(SafeFileHandle handle, bool wantDirectory) {
        const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        FileAttributeTagInfo info;
        if (!GetFileInformationByHandleEx(handle, 9, out info,
                (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != wantDirectory) {
            throw new IOException("目标句柄是链接或文件类型不符；拒绝修改。");
        }
        if (!wantDirectory) {
            ByHandleFileInformation fileInfo;
            if (!GetFileInformationByHandle(handle, out fileInfo)) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (fileInfo.NumberOfLinks != 1) {
                throw new IOException("目标文件有多个硬链接；拒绝修改共享字节。");
            }
        }
    }

    private static void CheckPhysicalPath(SafeFileHandle handle, string expected) {
        string actual = PhysicalPath(handle);
        if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) {
            throw new IOException("目标物理路径与预检冻结目录不符；保留外部文件与备份。");
        }
    }

    public static void AssertPhysicalPath(FileStream stream, string expected) {
        CheckPhysicalPath(stream.SafeFileHandle, expected);
    }

    public static SafeFileHandle OpenTrustedDirectory(string path) {
        const uint FILE_READ_ATTRIBUTES = 0x00000080;
        const uint FILE_SHARE_READ = 1;
        const uint FILE_SHARE_WRITE = 2;
        const uint FILE_SHARE_DELETE = 4;
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        SafeFileHandle handle = CreateFile(path, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        try {
            CheckAttributes(handle, true);
            PhysicalPath(handle);
            return handle;
        } catch {
            handle.Dispose();
            throw;
        }
    }

    private static FileStream Open(string path, uint access, FileAccess streamAccess,
                                   string expectedPhysicalPath, uint creation) {
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        SafeFileHandle handle = CreateFile(path, access, 0, IntPtr.Zero,
            creation, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        try {
            CheckAttributes(handle, false);
            CheckPhysicalPath(handle, expectedPhysicalPath);
            return new FileStream(handle, streamAccess);
        } catch (Exception openError) {
            // CREATE_NEW may already have created an empty file. Delete that
            // exact handle, never a potentially replaced pathname.
            if (creation != OPEN_EXISTING) {
                try {
                    DeleteHandle(handle);
                } catch (Exception cleanupError) {
                    handle.Dispose();
                    throw new IOException("新文件物理身份拒绝后，句柄级清理失败；保留现场与备份。",
                        new AggregateException(openError, cleanupError));
                }
            }
            handle.Dispose();
            throw;
        }
    }

    public static FileStream OpenReadWrite(string path, string expectedPhysicalPath) {
        const uint GENERIC_READ = 0x80000000;
        const uint GENERIC_WRITE = 0x40000000;
        const uint OPEN_EXISTING = 3;
        return Open(path, GENERIC_READ | GENERIC_WRITE, FileAccess.ReadWrite,
                    expectedPhysicalPath, OPEN_EXISTING);
    }

    public static FileStream OpenRead(string path, string expectedPhysicalPath) {
        const uint GENERIC_READ = 0x80000000;
        const uint OPEN_EXISTING = 3;
        return Open(path, GENERIC_READ, FileAccess.Read, expectedPhysicalPath, OPEN_EXISTING);
    }

    public static FileStream OpenForDelete(string path, string expectedPhysicalPath) {
        const uint GENERIC_READ = 0x80000000;
        const uint DELETE = 0x00010000;
        const uint OPEN_EXISTING = 3;
        return Open(path, GENERIC_READ | DELETE, FileAccess.Read,
                    expectedPhysicalPath, OPEN_EXISTING);
    }

    public static FileStream CreateNew(string path, string expectedPhysicalPath) {
        const uint GENERIC_READ = 0x80000000;
        const uint GENERIC_WRITE = 0x40000000;
        const uint DELETE = 0x00010000;
        const uint CREATE_NEW = 1;
        return Open(path, GENERIC_READ | GENERIC_WRITE | DELETE, FileAccess.ReadWrite,
                    expectedPhysicalPath, CREATE_NEW);
    }

    private static void DeleteHandle(SafeFileHandle handle) {
        FileDispositionInfo info = new FileDispositionInfo { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, 4, ref info,
                (uint)Marshal.SizeOf(typeof(FileDispositionInfo)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Delete(FileStream stream) {
        DeleteHandle(stream.SafeFileHandle);
    }
}
'@
}

function Get-ExclusiveSourceSnapshot([string]$Path, [string]$ExpectedNormalized,
                                     [string]$ExpectedRaw) {
    Ensure-NativeFileHandleType
    $physical = Get-TrustedPhysicalFilePath $Path
    $stream = [QianshouH3NativeFileHandle]::OpenRead($Path, $physical)
    try {
        [byte[]]$bytes = Read-StreamBytes $stream
        # Verify the known source pin on the same bytes before freezing raw SHA.
        # A separate pathname check can otherwise adopt a concurrent external edit.
        if ($ExpectedNormalized -and
                (Get-NormalizedBytesSha256 $bytes $Path) -ne $ExpectedNormalized) {
            throw "独占读取的源码摘要与已知基线不符；拒绝采纳并发修改：$Path"
        }
        $raw = Get-BytesSha256 $bytes
        if ($ExpectedRaw -and $raw -ne $ExpectedRaw) {
            throw "独占读取的原始字节摘要与冻结值不符；拒绝采纳并发修改：$Path"
        }
        [QianshouH3NativeFileHandle]::AssertPhysicalPath($stream, $physical)
        return [pscustomobject]@{ Bytes = $bytes; RawSha256 = $raw }
    } finally {
        $stream.Dispose()
    }
}

function Get-ExclusiveRawSha256([string]$Path, [string]$ExpectedNormalized) {
    $snapshot = Get-ExclusiveSourceSnapshot $Path $ExpectedNormalized $null
    return $snapshot.RawSha256
}

function Get-TrustedPhysicalFilePath([string]$Path) {
    if (-not $script:trustedWorkbenchPhysical) {
        throw '尚未固定可信 workbench 物理目录；拒绝访问 live 文件。'
    }
    $leaf = [System.IO.Path]::GetFileName($Path)
    if ($leaf -notin @('workbench_node.py', 'recipe_identity.py', 'runtime_attestation.py')) {
        throw '目标文件名不在安装器固定清单内；拒绝访问。'
    }
    return $script:trustedWorkbenchPhysical + '\' + $leaf
}

function Set-FileBytesCas([string]$Path, [string]$ExpectedRaw, [byte[]]$DesiredBytes,
                          [string]$DesiredRaw, [string]$Label) {
    if ((Get-BytesSha256 $DesiredBytes) -ne $DesiredRaw) {
        throw "$Label 的预备字节摘要不符；拒绝写入。"
    }
    # The same exclusive handle owns both the comparison and write. A pathname
    # hash followed by a separate Copy-Item would allow a concurrent overwrite.
    Ensure-NativeFileHandleType
    $physical = Get-TrustedPhysicalFilePath $Path
    $stream = [QianshouH3NativeFileHandle]::OpenReadWrite($Path, $physical)
    try {
        $before = Read-StreamBytes $stream
        if ((Get-BytesSha256 $before) -ne $ExpectedRaw) {
            throw "$Label 在提交前发生并发修改；保留外部字节与备份。"
        }
        $started = $false
        try {
            $started = $true
            Write-StreamBytes $stream $DesiredBytes
            if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $DesiredRaw) {
                throw "$Label 写入后的字节摘要不符。"
            }
            [QianshouH3NativeFileHandle]::AssertPhysicalPath($stream, $physical)
        } catch {
            $writeError = $_.Exception.Message
            if ($started) {
                try {
                    Write-StreamBytes $stream $before
                    if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $ExpectedRaw) {
                        throw '锁内恢复字节摘要不符'
                    }
                } catch {
                    throw "$Label 写入失败：$writeError；锁内恢复也失败：$($_.Exception.Message)。备份仍保留。"
                }
            }
            throw "$Label 写入失败：$writeError；已在独占锁内恢复原始字节。"
        }
    } finally {
        $stream.Dispose()
    }
}

function Remove-FileCas([string]$Path, [string]$ExpectedRaw, [string]$Label) {
    # A pathname delete after checking an open stream is not a CAS: another
    # process could rename that file and create a different file at the path.
    # Mark the verified, exclusively opened handle itself for deletion.
    Ensure-NativeFileHandleType
    $physical = Get-TrustedPhysicalFilePath $Path
    $stream = [QianshouH3NativeFileHandle]::OpenForDelete($Path, $physical)
    try {
        if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $ExpectedRaw) {
            throw "$Label 当前字节已被外部修改；保留现场与备份，不删除。"
        }
        [QianshouH3NativeFileHandle]::AssertPhysicalPath($stream, $physical)
        [QianshouH3NativeFileHandle]::Delete($stream)
    } finally {
        $stream.Dispose()
    }
}

function Assert-NoReparsePoint([string]$Path, [string]$Label) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
        throw "$Label 是符号链接或目录接点；为避免改动链接外文件，拒绝安装。"
    }
}

function Get-PathKey([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path.TrimEnd('\').ToLowerInvariant())
        return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Invoke-InMemorySyntaxCheck([string]$Python, [string]$Workbench,
                                    [hashtable]$ExpectedRaw) {
    $records = @()
    foreach ($name in @('workbench_node.py', 'recipe_identity.py', 'runtime_attestation.py')) {
        if (-not $ExpectedRaw.ContainsKey($name)) { throw "缺少 $name 的冻结原始摘要。" }
        $normalizedPin = if ($name -eq 'workbench_node.py') { $installedNodeHash } else { $bundle[$name] }
        # Open an exclusive trusted physical handle, then verify both the
        # known normalized pin and frozen raw hash on those exact bytes.
        $snapshot = Get-ExclusiveSourceSnapshot (Join-Path $Workbench $name) $normalizedPin $ExpectedRaw[$name]
        $records += [ordered]@{
            filename = $name
            sha256 = $snapshot.RawSha256
            base64 = [System.Convert]::ToBase64String([byte[]]$snapshot.Bytes)
        }
    }
    $json = ConvertTo-Json -InputObject $records -Depth 4 -Compress
    [byte[]]$stdinBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    # The command receives source only as pinned bytes through binary stdin.
    # compile() parses but does not import or execute the H3 source or make pyc.
    $code = "import base64,hashlib,json,sys; p=json.loads(sys.stdin.buffer.read()); names=['workbench_node.py','recipe_identity.py','runtime_attestation.py']; (isinstance(p,list) and len(p)==3 and [x['filename'] for x in p]==names) or sys.exit(3); b=[base64.b64decode(x['base64'],validate=True) for x in p]; all(hashlib.sha256(b[i]).hexdigest()==p[i]['sha256'] for i in range(3)) or sys.exit(4); [compile(b[i],names[i],'exec') for i in range(3)]"
    $arguments = '-B -I -S -c "' + $code + '"'
    $result = Invoke-BinaryStdinProcess $Python ([System.Environment]::SystemDirectory) $arguments $stdinBytes 'Python 内存语法检查'
    if ($result.ExitCode -ne 0) {
        throw "Python 内存语法 compile(bytes) 未通过（exit $($result.ExitCode)）：$($result.Stderr.Trim())"
    }
}

function Copy-ModuleAtomically([string]$Source, [string]$Target, [string]$Expected) {
    $moduleBytes = [System.IO.File]::ReadAllBytes($Source)
    Assert-Hash $Source $Expected '私有副本模块'
    $stageRaw = Get-BytesSha256 $moduleBytes
    Ensure-NativeFileHandleType
    # CREATE_NEW is the existence check and creation in one operation. The
    # physical-path check and write use that same exclusive target handle.
    $physical = Get-TrustedPhysicalFilePath $Target
    $stream = [QianshouH3NativeFileHandle]::CreateNew($Target, $physical)
    try {
        try {
            Write-StreamBytes $stream $moduleBytes
            if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $stageRaw) {
                throw '新模块写入后的字节摘要不符。'
            }
            [QianshouH3NativeFileHandle]::AssertPhysicalPath($stream, $physical)
        } catch {
            $writeError = $_.Exception.Message
            try {
                [QianshouH3NativeFileHandle]::Delete($stream)
            } catch {
                throw "新模块写入失败：$writeError；锁内删除本脚本创建的文件也失败：$($_.Exception.Message)。"
            }
            throw "新模块写入失败：$writeError；已在独占锁内删除本脚本创建的文件。"
        }
        return $stageRaw
    } finally {
        $stream.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $ApiRoot -PathType Container)) {
    throw 'H3 API 根目录不存在；请把 -ApiRoot 指向该机器已有 H3 API 源码根。'
}
$apiRootPath = (Resolve-Path -LiteralPath $ApiRoot).ProviderPath
$workbench = Join-Path $apiRootPath 'workbench'
$nodePath = Join-Path $workbench 'workbench_node.py'
$patchPath = Join-Path $PSScriptRoot 'workbench_node.identity.patch'
$moduleNames = @('recipe_identity.py', 'runtime_attestation.py')
Assert-NoReparsePoint $apiRootPath 'H3 API 根目录'
if (-not (Test-Path -LiteralPath $workbench -PathType Container)) {
    throw '缺少 workbench 目录；此 H3 基线不兼容，未改动文件。'
}
Assert-NoReparsePoint $workbench 'workbench 目录'
Ensure-NativeFileHandleType
$trustedWorkbenchHandle = $null
try {
    $trustedWorkbenchHandle = [QianshouH3NativeFileHandle]::OpenTrustedDirectory($workbench)
    $script:trustedWorkbenchPhysical = [QianshouH3NativeFileHandle]::PhysicalPath($trustedWorkbenchHandle)
} catch {
    if ($trustedWorkbenchHandle) { $trustedWorkbenchHandle.Dispose() }
    throw "无法固定可信 workbench 物理目录：$($_.Exception.Message)；未改动文件。"
}
try {
$localH3 = Join-Path $apiRootPath 'local_h3'
if (-not (Test-Path -LiteralPath $localH3 -PathType Container)) {
    throw '缺少 local_h3 目录；此 H3 基线不兼容，未改动文件。'
}
Assert-NoReparsePoint $localH3 'local_h3 目录'

foreach ($name in $bundle.Keys) {
    Assert-Hash (Join-Path $PSScriptRoot $name) $bundle[$name] "安装包 $name"
}
# Git for Windows may check this .patch out as CRLF. Recheck its source pin,
# reject isolated CR, then send LF bytes directly to git apply stdin.
[byte[]]$sourcePatchBytes = [System.IO.File]::ReadAllBytes($patchPath)
if ((Get-NormalizedBytesSha256 $sourcePatchBytes $patchPath) -ne $bundle['workbench_node.identity.patch']) {
    throw '补丁文件在安装包校验后发生变化；拒绝使用。'
}
[byte[]]$lfPatchBytes = Convert-ToLfBytes $sourcePatchBytes $patchPath
if ((Get-BytesSha256 $lfPatchBytes) -ne $bundle['workbench_node.identity.patch']) {
    throw '规范化补丁摘要与安装包固定值不符；拒绝使用。'
}
foreach ($relative in $baseline.Keys) {
    if ($relative -eq 'workbench\workbench_node.py') { continue }
    Assert-Hash (Join-Path $apiRootPath $relative) $baseline[$relative] $relative
}
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw '缺少 workbench\workbench_node.py；此 H3 基线不兼容，未改动文件。'
}
Assert-NoReparsePoint $nodePath 'workbench_node.py'
$nodeHash = Get-NormalizedSha256 $nodePath
if ($nodeHash -ne $baseline['workbench\workbench_node.py'] -and $nodeHash -ne $installedNodeHash) {
    throw "workbench\workbench_node.py 的源码摘要不匹配（当前 $nodeHash）；拒绝强制补丁，未改动文件。"
}

foreach ($name in $moduleNames) {
    $target = Join-Path $workbench $name
    if (Test-Path -LiteralPath $target) {
        Assert-Hash $target $bundle[$name] "已有模块 $name"
    }
}
try {
    $python = (Get-Command $PythonExe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
} catch {
    throw '未找到指定的 Python；请传入该 H3 环境的 -PythonExe，未改动文件。'
}
& $python -c 'import sys,psutil,yaml; sys.exit(0 if sys.version_info >= (3,11) else 1)'
if ($LASTEXITCODE -ne 0) {
    throw '指定的 Python 需为 3.11+ 且安装 psutil、PyYAML；未改动文件。'
}
if ($nodeHash -eq $installedNodeHash) {
    $installedRaw = @{ 'workbench_node.py' = Get-ExclusiveRawSha256 $nodePath $installedNodeHash }
    foreach ($name in $moduleNames) {
        Assert-Hash (Join-Path $workbench $name) $bundle[$name] "已安装模块 $name"
        $installedRaw[$name] = Get-ExclusiveRawSha256 (Join-Path $workbench $name) $bundle[$name]
    }
    Invoke-InMemorySyntaxCheck $python $workbench $installedRaw
    foreach ($name in @('workbench_node.py') + $moduleNames) {
        if ((Get-ExclusiveRawSha256 (Join-Path $workbench $name)) -ne $installedRaw[$name]) {
            throw "内存语法检查期间 $name 发生并发改动；拒绝已安装自检。"
        }
    }
    Write-Output '已安装且源码、Python 依赖与内存语法 compile(bytes) 校验通过；没有改动 H3 文件。'
    return
}
try {
    $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
} catch {
    throw '未找到 Git for Windows；无法安全核验和应用补丁，未改动文件。'
}
$preflight = Invoke-GitApplyPatch $git $apiRootPath $lfPatchBytes $true
if ($preflight.ExitCode -ne 0) {
    throw '补丁预检未通过；此 H3 基线不兼容，拒绝强制补丁，未改动文件。'
}
if ($CheckOnly) {
    Get-ExclusiveRawSha256 $nodePath $baseline['workbench\workbench_node.py'] | Out-Null
    foreach ($name in $moduleNames) {
        $target = Join-Path $workbench $name
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            Get-ExclusiveRawSha256 $target $bundle[$name] | Out-Null
        }
    }
    Write-Output '基线、补丁和 Python 依赖预检通过；未改动文件。'
    return
}

$localAppData = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
if (-not $localAppData -or -not (Test-Path -LiteralPath $localAppData -PathType Container)) {
    throw '无法定位当前用户的 LocalAppData；为避免把备份放进源码树，安装已中止。'
}
$backupRoot = Join-Path $localAppData ('Qianshou\H3AdapterBackups\' + (Get-PathKey $apiRootPath))
$backupDir = Join-Path $backupRoot ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N'))
$originallyPresent = @{}
$writtenRaw = @{}
$mutationStarted = $false
try {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($name in @('workbench_node.py') + $moduleNames) {
        $source = Join-Path $workbench $name
        $originallyPresent[$name] = Test-Path -LiteralPath $source -PathType Leaf
        if ($originallyPresent[$name]) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir $name) -Force
            if ((Get-RawSha256 $source) -ne (Get-RawSha256 (Join-Path $backupDir $name))) {
                throw "备份校验失败：$name；未应用补丁。"
            }
        }
    }
    # Patch a private copy of the exact backup. Its raw bytes, rather than
    # unknown bytes sampled from the live path after git apply, define the
    # only payload that this installer may later claim as its own.
    $stageRoot = Join-Path $backupDir 'stage'
    $stageWork = Join-Path $stageRoot 'workbench'
    New-Item -ItemType Directory -Path $stageWork -Force | Out-Null
    $stageNode = Join-Path $stageWork 'workbench_node.py'
    Copy-Item -LiteralPath (Join-Path $backupDir 'workbench_node.py') -Destination $stageNode
    $stageCheck = Invoke-GitApplyPatch $git $stageRoot $lfPatchBytes $true
    if ($stageCheck.ExitCode -ne 0) { throw '私有副本补丁预检未成功。' }
    $stageApply = Invoke-GitApplyPatch $git $stageRoot $lfPatchBytes $false
    if ($stageApply.ExitCode -ne 0) { throw '私有副本 git apply 未成功。' }
    Assert-Hash $stageNode $installedNodeHash '私有副本补丁结果'
    $stageBytes = [System.IO.File]::ReadAllBytes($stageNode)
    $stageRaw = Get-BytesSha256 $stageBytes
    $backupNodeRaw = Get-RawSha256 (Join-Path $backupDir 'workbench_node.py')
    $expectedFinalRaw = @{ 'workbench_node.py' = $stageRaw }
    $stagedModules = @{}
    foreach ($name in $moduleNames) {
        if ($originallyPresent[$name]) {
            $expectedFinalRaw[$name] = Get-RawSha256 (Join-Path $backupDir $name)
        } else {
            $stagedModules[$name] = Join-Path $stageWork $name
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stagedModules[$name]
            Assert-Hash $stagedModules[$name] $bundle[$name] "私有副本模块 $name"
            $expectedFinalRaw[$name] = Get-RawSha256 $stagedModules[$name]
        }
    }
    # Recheck every baseline and pre-existing module after backup, immediately
    # before any source mutation. A concurrent edit must be rejected.
    foreach ($relative in $baseline.Keys) {
        Assert-Hash (Join-Path $apiRootPath $relative) $baseline[$relative] "待安装 $relative"
    }
    if ((Get-RawSha256 $nodePath) -ne (Get-RawSha256 (Join-Path $backupDir 'workbench_node.py'))) {
        throw '备份后 workbench_node.py 又发生变化；拒绝覆盖并发修改。'
    }
    foreach ($name in $moduleNames) {
        $target = Join-Path $workbench $name
        $exists = Test-Path -LiteralPath $target -PathType Leaf
        if ($exists -ne $originallyPresent[$name]) {
            throw "备份后 $name 的存在状态发生变化；拒绝覆盖并发修改。"
        }
        if ($exists) {
            Assert-Hash $target $bundle[$name] "待安装 $name"
            if ((Get-RawSha256 $target) -ne (Get-RawSha256 (Join-Path $backupDir $name))) {
                throw "备份后 $name 又发生变化；拒绝覆盖并发修改。"
            }
        }
    }
    $mutationStarted = $true
    Set-FileBytesCas $nodePath $backupNodeRaw $stageBytes $stageRaw 'workbench_node.py'
    $writtenRaw['workbench_node.py'] = $stageRaw
    foreach ($name in $moduleNames) {
        if (-not $originallyPresent[$name]) {
            $writtenRaw[$name] = Copy-ModuleAtomically $stagedModules[$name] (Join-Path $workbench $name) $bundle[$name]
            if ($writtenRaw[$name] -ne $expectedFinalRaw[$name]) {
                throw "$name 的复制字节与预备摘要不符；拒绝采纳未知字节。"
            }
        }
        Assert-Hash (Join-Path $workbench $name) $bundle[$name] "安装后的 $name"
        if ((Get-ExclusiveRawSha256 (Join-Path $workbench $name)) -ne $expectedFinalRaw[$name]) {
            throw "$name 安装后出现并发改动；保留现场与备份。"
        }
    }
    Invoke-InMemorySyntaxCheck $python $workbench $expectedFinalRaw
    foreach ($name in @('workbench_node.py') + $moduleNames) {
        if ((Get-ExclusiveRawSha256 (Join-Path $workbench $name)) -ne $expectedFinalRaw[$name]) {
            throw "内存语法检查期间 $name 发生并发改动；保留现场与备份。"
        }
    }
    Write-Output "安装成功；三个模块已通过内存语法 compile(bytes)。原文件备份：$backupDir"
} catch {
    $cause = $_.Exception.Message
    if (-not $mutationStarted) { throw "安装中止：$cause；未改动 H3 源文件。" }
    $restoreErrors = @()
    foreach ($name in @('workbench_node.py') + $moduleNames) {
        $target = Join-Path $workbench $name
        try {
            $exists = Test-Path -LiteralPath $target -PathType Leaf
            if ($exists) { Assert-NoReparsePoint $target $name }
            if (-not $writtenRaw.ContainsKey($name)) {
                if ($name -eq 'workbench_node.py' -and
                    (-not $exists -or (Get-ExclusiveRawSha256 $target) -ne $backupNodeRaw)) {
                    throw '补丁未确认写入，目标却变化；保留现场与备份，不覆盖并发修改'
                }
                if ($name -ne 'workbench_node.py' -and -not $originallyPresent[$name] -and $exists) {
                    throw '复制未确认完成，目标却出现；保留现场与备份，不删除未知文件'
                }
                continue
            }
            if (-not $exists) { throw '本脚本写入后目标已消失；保留现场与备份' }
            if ($originallyPresent[$name]) {
                $backupBytes = [System.IO.File]::ReadAllBytes((Join-Path $backupDir $name))
                if ($name -eq 'workbench_node.py' -and (Get-BytesSha256 $backupBytes) -ne $backupNodeRaw) {
                    throw '原文件备份字节发生变化；拒绝使用未知备份恢复'
                }
                Set-FileBytesCas $target $writtenRaw[$name] $backupBytes (Get-BytesSha256 $backupBytes) $name
            } else {
                Remove-FileCas $target $writtenRaw[$name] $name
            }
        } catch {
            $restoreErrors += "$name：$($_.Exception.Message)"
        }
    }
    if ($restoreErrors.Count -gt 0) {
        throw "安装失败：$cause；自动恢复未完全成功。原文件仍在 $backupDir。失败项：$($restoreErrors -join '；')"
    }
    throw "安装失败：$cause；已恢复本脚本写入的文件，未覆盖其他文件。原文件备份：$backupDir。"
}
} finally {
    $trustedWorkbenchHandle.Dispose()
}
