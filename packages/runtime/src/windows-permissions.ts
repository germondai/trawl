import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
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
  try {
    await exec(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, TRAWL_PERMISSION_PATH: path, TRAWL_PERMISSION_KIND: directory ? "directory" : "file" },
      },
    )
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean }
    const detail = failure.killed
      ? "PowerShell timed out"
      : typeof failure.code === "number"
        ? `PowerShell exit code ${failure.code}`
        : "PowerShell could not be started"
    throw new Error(`Cannot protect local storage permissions; use a private NTFS user directory (${detail})`)
  }
}
