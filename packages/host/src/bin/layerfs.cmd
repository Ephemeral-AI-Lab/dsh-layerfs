@echo off
setlocal DisableDelayedExpansion
if not defined DSH_LAYERFS_CLI (
  echo layerfs: this conversation has no LayerFS project 1>&2
  exit /b 2
)
node "%DSH_LAYERFS_CLI%" %*
exit /b %errorlevel%
