# LayerFS command on PATH for Windows. PowerShell resolves this .ps1 before the
# .cmd beside it and passes arguments as objects, so a multi-line argument keeps
# its newlines; cmd.exe cuts the command line at a newline, which is why the
# .cmd cannot carry one. DSH's bash tool on Windows is PowerShell, so agents get
# this path. The .cmd stays for cmd.exe callers.
#
# Pipeline input is forwarded as the bytes PowerShell would have given a native
# command (each object plus CRLF): a cmd.exe batch file loses a piped handle,
# which turned "text | layerfs fs write" into an empty Commit. The child's
# output is captured and re-emitted so a pipeline around the shim still reads
# the JSON it prints.
if (-not $env:DSH_LAYERFS_CLI) {
  [Console]::Error.WriteLine("layerfs: this conversation has no LayerFS project")
  exit 2
}
$items = @($input)
if ($items.Count -eq 0) {
  & node $env:DSH_LAYERFS_CLI @args
  exit $LASTEXITCODE
}
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = "node"
$start.ArgumentList.Add($env:DSH_LAYERFS_CLI)
foreach ($arg in $args) { $start.ArgumentList.Add([string]$arg) }
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
$start.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
$child = [System.Diagnostics.Process]::Start($start)
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
$writer = [System.IO.StreamWriter]::new($child.StandardInput.BaseStream, [System.Text.UTF8Encoding]::new($false))
foreach ($item in $items) {
  $writer.Write([string]$item)
  $writer.Write("`r`n")
}
$writer.Flush()
$writer.Dispose()
$child.WaitForExit()
if ($stderr.Result.Length -gt 0) { [Console]::Error.Write($stderr.Result) }
if ($stdout.Result.Length -gt 0) { Write-Output $stdout.Result }
exit $child.ExitCode
