# LayerFS command on PATH for Windows. PowerShell resolves this .ps1 before the
# .cmd beside it and passes arguments as objects, so a multi-line argument keeps
# its newlines; cmd.exe cuts the command line at a newline, which is why the
# .cmd cannot carry one. DSH's bash tool on Windows is PowerShell, so agents get
# this path. The .cmd stays for cmd.exe callers.
if (-not $env:DSH_LAYERFS_CLI) {
  [Console]::Error.WriteLine("layerfs: this conversation has no LayerFS project")
  exit 2
}
& node $env:DSH_LAYERFS_CLI @args
exit $LASTEXITCODE
