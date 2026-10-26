# Return system idle seconds (since last keyboard/mouse input), for pause auto-resume.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class IdleTimeProbe {
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
'@
$t = New-Object IdleTimeProbe+LASTINPUTINFO
$t.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($t)
$ok = [IdleTimeProbe]::GetLastInputInfo([ref]$t)
if (-not $ok) { [Console]::Out.Write("-1"); exit 1 }
$idleSec = [math]::Round(([Environment]::TickCount - $t.dwTime) / 1000)
[Console]::Out.Write([string]$idleSec)
exit 0
