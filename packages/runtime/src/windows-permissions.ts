import { join } from "node:path"

// Windows ignores POSIX mode bits; replace the DACL rather than inheriting a shared directory's permissions.
export async function protectWindowsStorage(path: string, directory: boolean) {
  if (process.platform !== "win32") return
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = $env:TRAWL_PERMISSION_KIND -eq 'directory'
$acl = if ($directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]'S-1-5-18')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:TRAWL_PERMISSION_PATH -AclObject $acl
`
  const signal = AbortSignal.timeout(10000)
  let detail: string
  try {
    const operation = Bun.spawn(
      [
        join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        signal,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
        env: { ...process.env, TRAWL_PERMISSION_PATH: path, TRAWL_PERMISSION_KIND: directory ? "directory" : "file" },
      },
    )
    const exit = await operation.exited
    if (exit === 0 && !signal.aborted) return
    detail = `PowerShell exit code ${exit}`
  } catch {
    detail = "PowerShell could not be started"
  }
  throw new Error(
    `Cannot protect local storage permissions; use a private NTFS user directory (${signal.aborted ? "PowerShell timed out" : detail})`,
  )
}
