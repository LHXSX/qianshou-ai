#Requires -Version 5.1
# Explicit fixed-baseline V2 upgrade only. Never starts Comfy/API/GPU, creates
# owner config, changes platform authority, or reuses a V1 self-test receipt.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ApiRoot,
    [Parameter(Mandatory = $true)][string]$ComfyRoot,
    [string]$PythonExe = 'python.exe',
    [switch]$CheckOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw '此脚本要求Windows PowerShell 5.1/.NET Framework；未改动文件。' }
if ($env:OS -ne 'Windows_NT') { throw '此脚本只支持 Windows PowerShell 5.1+；未改动文件。' }
$script:DirectoryLocks = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$script:SourceLocks = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$manifestPin = '675ae97f6e5e2b496b33293ce89af03e5d73f721f562bc5accbee909772f6867'
$validatorPin = '3d69399c115629ea19aaf5fd61dfb4677f012034b9d3207381ed8d4c8742a73d'
$patchPin = '58cb96e873b5e2af7efb986c96046271eaf5294e89525a1f16947bf155d321a2'
$helperPin = 'df371e075d6d478d5f7612473d7f31c008b35c204a58c1953d500103dbd040d8'
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
    if (([System.Management.Automation.PSTypeName]'QianshouH3V2NativeFileHandle').Type) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class QianshouH3V2NativeFileHandle {
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
            FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
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


function Lock-DirectoryChain([string]$Path) {
    # Lock every logical ancestor without write/delete sharing. A directory
    # junction/rename must not redirect Git, Python, backup or live CAS paths.
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full -ne [IO.Path]::GetPathRoot($full)) { $full = $full.TrimEnd('\') }
    $chain = New-Object 'System.Collections.Generic.List[string]'
    $cursor = $full
    while ($cursor) {
        $chain.Add($cursor)
        $parent = [System.IO.Directory]::GetParent($cursor)
        if (-not $parent) { break }
        $cursor = $parent.FullName
    }
    $leafHandle = $null
    for ($i = $chain.Count - 1; $i -ge 0; $i--) {
        if (-not (Test-Path -LiteralPath $chain[$i] -PathType Container)) { throw '缺少源码/备份父目录；未改动文件。' }
        $handle = [QianshouH3V2NativeFileHandle]::OpenTrustedDirectory($chain[$i])
        $script:DirectoryLocks.Add($handle)
        if ($i -eq 0) { $leafHandle = $handle }
    }
    return [pscustomobject]@{ Logical = $full; Physical = [QianshouH3V2NativeFileHandle]::PhysicalPath($leafHandle) }
}

function Get-Snapshot([string]$Path, [string]$Physical, [string]$Expected, [bool]$PermitCrLf) {
    $stream = [QianshouH3V2NativeFileHandle]::OpenRead($Path, $Physical)
    try {
        [byte[]]$raw = Read-StreamBytes $stream
        if ($raw.Length -eq 0 -or $raw.Length -gt 4194304) { throw '源码超过界限或为空；未改动文件。' }
        [byte[]]$canonical = if ($PermitCrLf) { Convert-ToLfBytes $raw '固定 V1 适配器' } else { $raw }
        if ((Get-BytesSha256 $canonical) -ne $Expected) { throw '源码字节与固定支持清单不符；拒绝升级。' }
        [QianshouH3V2NativeFileHandle]::AssertPhysicalPath($stream, $Physical)
        $script:SourceLocks.Add($stream)
        return [pscustomobject]@{ Bytes = $raw; Canonical = $canonical; RawSha256 = Get-BytesSha256 $raw; Stream = $stream }
    } catch { $stream.Dispose(); throw }
}

function Read-Bundle([string]$Relative, [string]$Expected, [bool]$Lf) {
    $path = Join-Path $bundleRoot.Logical $Relative
    $snapshot = Get-Snapshot $path ($bundleRoot.Physical + '\' + $Relative.Replace('/', '\')) $Expected $Lf
    return ,$snapshot.Canonical
}

function Write-NewPinned([string]$Path, [string]$Physical, [byte[]]$Bytes, [string]$Expected) {
    if ((Get-BytesSha256 $Bytes) -ne $Expected) { throw '待创建字节与固定摘要不符。' }
    $stream = [QianshouH3V2NativeFileHandle]::CreateNew($Path, $Physical)
    try {
        try {
            Write-StreamBytes $stream $Bytes
            if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $Expected) { throw '新文件摘要校验失败。' }
            [QianshouH3V2NativeFileHandle]::AssertPhysicalPath($stream, $Physical)
        } catch {
            $cause = $_.Exception
            try { [QianshouH3V2NativeFileHandle]::Delete($stream) }
            catch { throw [System.AggregateException]::new('创建失败且句柄级清理失败；保留备份。', [Exception[]]@($cause, $_.Exception)) }
            throw $cause
        }
    } finally { $stream.Dispose() }
}

function Set-PinnedCas([string]$Path, [string]$Physical, [string]$Before,
                       [byte[]]$AfterBytes, [string]$After) {
    if ((Get-BytesSha256 $AfterBytes) -ne $After) { throw '待提交字节摘要不符。' }
    $stream = [QianshouH3V2NativeFileHandle]::OpenReadWrite($Path, $Physical)
    try {
        [byte[]]$previous = Read-StreamBytes $stream
        if ((Get-BytesSha256 $previous) -ne $Before) { throw '提交前发生外部修改；保留外部字节与备份。' }
        try {
            Write-StreamBytes $stream $AfterBytes
            if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $After) { throw '提交后摘要不符。' }
            [QianshouH3V2NativeFileHandle]::AssertPhysicalPath($stream, $Physical)
        } catch {
            $cause = $_.Exception
            try {
                Write-StreamBytes $stream $previous
                if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $Before) { throw '锁内恢复摘要不符。' }
            } catch { throw [System.AggregateException]::new('写入与锁内恢复失败；保留备份。', [Exception[]]@($cause, $_.Exception)) }
            throw $cause
        }
    } finally { $stream.Dispose() }
}

function Remove-PinnedCas([string]$Path, [string]$Physical, [string]$Expected) {
    $stream = [QianshouH3V2NativeFileHandle]::OpenForDelete($Path, $Physical)
    try {
        if ((Get-BytesSha256 (Read-StreamBytes $stream)) -ne $Expected) { throw '新模块已被外部修改；保留，不删除。' }
        [QianshouH3V2NativeFileHandle]::AssertPhysicalPath($stream, $Physical)
        [QianshouH3V2NativeFileHandle]::Delete($stream)
    } finally { $stream.Dispose() }
}

function Invoke-OfflineValidation([string]$Phase, [object[]]$Rows) {
    $envelope = [ordered]@{ schema = 'qianshou.h3-v2-install-validation.v1'; phase = $Phase; records = $Rows }
    $packet = [ordered]@{
        validator = [Convert]::ToBase64String($validatorBytes)
        validatorSha256 = $validatorPin
        payload = $envelope
    }
    [byte[]]$inputBytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $packet -Depth 8 -Compress))
    # No temp pyc/source and no imports from live paths: execute only the
    # separately pinned offline validator, with exact frozen source byte rows.
    $code = "import base64,hashlib,json,sys; p=json.loads(sys.stdin.buffer.read(33554433)); b=base64.b64decode(p['validator'],validate=True); hashlib.sha256(b).hexdigest()==p['validatorSha256']=='" + $validatorPin + "' or sys.exit(4); ns={'__name__':'pinned_install_validator'}; exec(compile(b,'pinned_install_validator','exec'),ns); print(json.dumps(ns['validate'](p['payload']),separators=(',',':')))"
    $result = Invoke-BinaryStdinProcess $python ([Environment]::SystemDirectory) ('-B -I -c "' + $code + '"') $inputBytes 'V2 离线源码检查'
    if ($result.ExitCode -ne 0) { throw "V2 内存语法/身份模块导入/路由合同检查失败（exit $($result.ExitCode)）；未声明 ready。" }
    $reply = $result.Stdout | ConvertFrom-Json
    if ($reply.schema -ne 'qianshou.h3-v2-install-validation-result.v1' -or $reply.phase -ne $Phase -or
        $reply.compiledRoles -ne 20 -or $reply.importedIdentityModules -ne 3 -or -not $reply.staticRouteContract -or
        $reply.servicesStarted -or $reply.gpuExecuted) { throw '离线检查回执不完整。' }
}

function New-ValidationRow([object]$Role, [byte[]]$Bytes) {
    return [ordered]@{ role = $Role.role; root = $Role.root; path = $Role.path;
        sha256 = Get-BytesSha256 $Bytes; base64 = [Convert]::ToBase64String($Bytes) }
}

function Assert-CanonicalSoftwareClosure {
    $closure = $manifest.canonicalSoftwareClosure
    $expected = @{}
    foreach ($file in $closure.files) {
        if ($file.root -notin @('api','comfy') -or $file.path -notmatch '^[A-Za-z0-9_. /-]+\.(py|pyd|dll)$' -or
            $file.path.StartsWith('/') -or $file.path.Split('/') -contains '..' -or $file.path.Split('/') -contains '.' -or
            $file.sha256 -notmatch '^[0-9a-f]{64}$') { throw '完整软件清单含非法/未固定源码条目；拒绝升级。' }
        $key = $file.root + '/' + $file.path
        if ($expected.ContainsKey($key)) { throw '完整软件清单有重复或大小写冲突路径；拒绝升级。' }
        $expected[$key] = $file
    }
    if ($expected.Count -lt 20 -or $expected.Count -gt 20000) { throw '完整软件清单数量不合理；拒绝升级。' }
    $measured = @{}
    foreach ($role in $manifest.sourceRoles) {
        $key = $role.root + '/' + $role.path
        $targetPin = if ($role.role -eq 'adapter') { $manifest.targetAdapterSha256 } else { $role.sha256 }
        if (-not $expected.ContainsKey($key) -or $expected[$key].sha256 -ne $targetPin) { throw '完整软件清单与20测量角色不一致；拒绝升级。' }
        $measured[$key] = $role.role
    }
    $seen = @{}
    foreach ($domainName in @('api','comfy')) {
        $domain = $roots[$domainName]
        $pending = New-Object 'System.Collections.Generic.Queue[string]'
        if ($domainName -eq 'api') { $pending.Enqueue('workbench'); $pending.Enqueue('local_h3') }
        else { $pending.Enqueue('') }
        $visited = 0
        while ($pending.Count -gt 0) {
            $relativeDirectory = $pending.Dequeue()
            $directory = Join-Path $domain.Logical $relativeDirectory
            $null = Lock-DirectoryChain $directory
            foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
                $visited++
                if ($visited -gt 100000) { throw '源码目录超出有界盘点范围；拒绝升级。' }
                $relative = if ($relativeDirectory) { $relativeDirectory + '/' + $item.Name } else { $item.Name }
                if ($item.PSIsContainer) {
                    # These are data/interpreter/cache roots, not canonical
                    # H3 import sources. YAML is separately private V2 config.
                    if ($item.Name -in @('models','input','output','.git','.venv','venv','__pycache__')) { continue }
                    if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw '软件源码目录含链接；拒绝升级。' }
                    $pending.Enqueue($relative)
                    continue
                }
                if ([IO.Path]::GetExtension($item.Name).ToLowerInvariant() -notin @('.py','.pyd','.dll')) { continue }
                $key = $domainName + '/' + $relative
                if (-not $expected.ContainsKey($key)) { throw '发现完整清单外的软件源码/扩展模块；拒绝采纳未知extras。' }
                if ($seen.ContainsKey($key)) { throw '实际软件树有重复或大小写冲突路径；拒绝升级。' }
                $seen[$key] = $true
                if ($measured.ContainsKey($key)) { continue } # Already held by fixed-role handles.
                $pin = $expected[$key]
                $null = Get-Snapshot $item.FullName ($domain.Physical + '\' + $relative.Replace('/','\')) $pin.sha256 $false
            }
        }
    }
    foreach ($key in $expected.Keys) {
        if ($seen.ContainsKey($key)) { continue }
        if ($key -eq 'api/workbench/recipe_identity_v2.py' -and -not $sourceSnapshots.ContainsKey('identityV2')) { continue }
        throw '完整软件清单中的必需源码缺失；拒绝占位或临时补齐。'
    }
}

function Assert-AdapterStopped {
    try { $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) }
    catch { throw '无法确认8790适配器已正常关闭；拒绝访问live源码。' }
    if (@($listeners | Where-Object { $_.LocalPort -eq 8790 }).Count -gt 0) {
        throw '8790适配器仍在运行；请本人正常关闭后再离线检查/升级。本脚本没有停止服务或改动源码。'
    }
}

function New-PrivateBackupDirectory {
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $local) { throw '无法定位本人 LocalAppData；未改动文件。' }
    $null = Lock-DirectoryChain $local
    $path = Join-Path $local ('Qianshou-H3V2-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $path) { throw '私有备份目录意外存在；拒绝复用。' }
    [IO.Directory]::CreateDirectory($path) | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($owner in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, $rights, $inherit,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    [IO.Directory]::SetAccessControl($path, $security)
    $frozen = Lock-DirectoryChain $path
    return $frozen
}

$sourceSnapshots = @{}
$managedNodeWritten = $false
$newHelperWritten = $false
$backup = $null
try {
    Ensure-NativeFileHandleType
    $bundleRoot = Lock-DirectoryChain $PSScriptRoot
    [byte[]]$manifestBytes = Read-Bundle 'adapter-v2.install.manifest.json' $manifestPin $true
    $manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    if ($manifest.schema -ne 'qianshou.h3-adapter-install.v2' -or $manifest.sourceRoles.Count -ne 20) { throw 'V2 安装清单结构不符。' }
    $missingPins = @($manifest.sourceRoles | Where-Object { $_.sha256 -notmatch '^[0-9a-f]{64}$' })
    if ($missingPins.Count -gt 0) {
        throw ('支持的 Comfy 源码摘要尚未收集：' + (($missingPins | ForEach-Object { $_.role }) -join '、') + '。这是固定基线升级器，不能代替新机完整软件安装；未改动文件。')
    }
    if ($manifest.canonicalSoftwareClosure.schema -ne 'qianshou.h3-canonical-software-closure.v1' -or
        -not $manifest.canonicalSoftwareClosure.complete -or $manifest.canonicalSoftwareClosure.files.Count -eq 0) {
        throw '完整canonical软件/LoRA guard/import源码清单尚未收集；20测量角色不能代替完整软件闭包。未改动文件。'
    }
    Assert-AdapterStopped
    $roots = @{ api = Lock-DirectoryChain $ApiRoot; comfy = Lock-DirectoryChain $ComfyRoot }
    [byte[]]$patchBytes = Read-Bundle 'workbench_node.v2.patch' $patchPin $true
    [byte[]]$helperBytes = Read-Bundle 'recipe_identity_v2.py' $helperPin $false
    [byte[]]$validatorBytes = Read-Bundle 'tests/validate_v2_upgrade.py' $validatorPin $true
    $python = (Get-Command $PythonExe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $workbench = Join-Path $roots.api.Logical 'workbench'
    $nodePath = Join-Path $workbench 'workbench_node.py'
    $nodePhysical = $roots.api.Physical + '\workbench\workbench_node.py'
    $helperPath = Join-Path $workbench 'recipe_identity_v2.py'
    $helperPhysical = $roots.api.Physical + '\workbench\recipe_identity_v2.py'
    # Check import-supporting files explicitly; no placeholder implementation
    # or automatic source download may be substituted for this installed recipe.
    foreach ($relative in @('workbench/runner.py', 'local_h3/__init__.py')) {
        if (-not (Test-Path -LiteralPath (Join-Path $roots.api.Logical $relative) -PathType Leaf)) { throw '固定 H3 API 运行源码闭包缺失；未改动文件。' }
    }
    $rows = @()
    $nodeSnapshot = $null
    $isInstalled = $false
    foreach ($role in $manifest.sourceRoles) {
        $domain = $roots[$role.root]
        $path = Join-Path $domain.Logical $role.path
        $null = Lock-DirectoryChain ([IO.Path]::GetDirectoryName($path))
        $physical = $domain.Physical + '\' + $role.path.Replace('/', '\')
        if ($role.role -eq 'identityV2' -and -not (Test-Path -LiteralPath $path)) {
            $rows += New-ValidationRow $role $helperBytes
            continue
        }
        if ($role.role -eq 'adapter') {
            # Admit only pinned baseline CRLF/LF or exact already-installed V2.
            try { $snap = Get-Snapshot $path $physical $manifest.baselineAdapterSha256 $true }
            catch { $snap = Get-Snapshot $path $physical $manifest.targetAdapterSha256 $false; $isInstalled = $true }
            $nodeSnapshot = $snap
        } else { $snap = Get-Snapshot $path $physical $role.sha256 $false }
        $sourceSnapshots[$role.role] = $snap
        $rows += New-ValidationRow $role $snap.Canonical
    }
    if ($isInstalled -and -not $sourceSnapshots.ContainsKey('identityV2')) { throw '已改成 V2 的适配器缺少身份模块；拒绝误判已安装。' }
    Assert-CanonicalSoftwareClosure
    Invoke-OfflineValidation $(if ($isInstalled) { 'target' } else { 'baseline' }) $rows
    if ($isInstalled) {
        Write-Output '已安装 V2；20 个固定源码角色及三个身份模块离线检查通过。没有启动服务/GPU，也没有声明已试用或已审核。'
        return
    }
    $backup = New-PrivateBackupDirectory
    $stageRoot = Join-Path $backup.Logical 'stage'
    $stageWork = Join-Path $stageRoot 'workbench'
    [IO.Directory]::CreateDirectory($stageWork) | Out-Null
    $stage = Lock-DirectoryChain $stageRoot
    $null = Lock-DirectoryChain $stageWork
    $stageNode = Join-Path $stageWork 'workbench_node.py'
    Write-NewPinned $stageNode ($stage.Physical + '\workbench\workbench_node.py') $nodeSnapshot.Canonical $manifest.baselineAdapterSha256
    $check = Invoke-GitApplyPatch $git $stageRoot $patchBytes $true
    if ($check.ExitCode -ne 0) { throw '固定副本补丁预检失败；未改动 live 源码。' }
    $apply = Invoke-GitApplyPatch $git $stageRoot $patchBytes $false
    if ($apply.ExitCode -ne 0) { throw '固定副本补丁失败；未改动 live 源码。' }
    $target = Get-Snapshot $stageNode ($stage.Physical + '\workbench\workbench_node.py') $manifest.targetAdapterSha256 $false
    $targetRows = @()
    foreach ($role in $manifest.sourceRoles) {
        [byte[]]$bytes = if ($role.role -eq 'adapter') { $target.Bytes } elseif ($role.role -eq 'identityV2') { $helperBytes } else { $sourceSnapshots[$role.role].Bytes }
        $targetRows += New-ValidationRow $role $bytes
    }
    Invoke-OfflineValidation 'target' $targetRows
    if ($CheckOnly) {
        Write-Output ('V2 固定基线、补丁及20源码离线检查通过；live源码未改。私有检查副本保留：' + $backup.Logical)
        return
    }
    Write-NewPinned (Join-Path $backup.Logical 'workbench_node.py.before') ($backup.Physical + '\workbench_node.py.before') $nodeSnapshot.Bytes $nodeSnapshot.RawSha256
    Assert-AdapterStopped
    # Other eighteen roles remain held by exclusive handles. The new module
    # must be CREATE_NEW, and the node write compares and writes one handle.
    if (-not $sourceSnapshots.ContainsKey('identityV2')) {
        Write-NewPinned $helperPath $helperPhysical $helperBytes $helperPin
        $newHelperWritten = $true
    }
    $nodeSnapshot.Stream.Dispose()
    Set-PinnedCas $nodePath $nodePhysical $nodeSnapshot.RawSha256 $target.Bytes $manifest.targetAdapterSha256
    $managedNodeWritten = $true
    $finalNode = Get-Snapshot $nodePath $nodePhysical $manifest.targetAdapterSha256 $false
    $sourceSnapshots['adapter'] = $finalNode
    if ($newHelperWritten) { $sourceSnapshots['identityV2'] = Get-Snapshot $helperPath $helperPhysical $helperPin $false }
    Invoke-OfflineValidation 'target' $targetRows
    # Same handles pin all source byte roles through final validation. No
    # authority/config/receipt is created by this successful source upgrade.
    Write-Output ('V2源码升级完成；离线20源码、身份模块导入与显式路由合同通过。备份：' + $backup.Logical + '。仍需本人新建V2配置并显式本机试用；没有启动服务/GPU或复用V1回执。')
} catch {
    $cause = $_.Exception
    $restore = @()
    # Release only managed handles before CAS rollback. Other fixed inputs
    # stay held; a caller never gets permission to replace external changes.
    foreach ($role in @('adapter','identityV2')) {
        if ($sourceSnapshots.ContainsKey($role)) { $sourceSnapshots[$role].Stream.Dispose() }
    }
    if ($newHelperWritten -and $sourceSnapshots.ContainsKey('identityV2')) { $sourceSnapshots.identityV2.Stream.Dispose() }
    if ($managedNodeWritten) {
        try { Set-PinnedCas $nodePath $nodePhysical $manifest.targetAdapterSha256 $nodeSnapshot.Bytes $nodeSnapshot.RawSha256 }
        catch { $restore += $_.Exception }
    }
    if ($newHelperWritten) {
        try { Remove-PinnedCas $helperPath $helperPhysical $helperPin }
        catch { $restore += $_.Exception }
    }
    if ($restore.Count -gt 0) { throw [AggregateException]::new('升级失败且CAS恢复有冲突；保留外部字节和私有备份。', [Exception[]](@($cause) + $restore)) }
    if ($backup) { throw [InvalidOperationException]::new(('升级未完成；私有备份保留：' + $backup.Logical), $cause) }
    throw $cause
} finally {
    foreach ($handle in $script:SourceLocks) { $handle.Dispose() }
    for ($i = $script:DirectoryLocks.Count - 1; $i -ge 0; $i--) { $script:DirectoryLocks[$i].Dispose() }
}
