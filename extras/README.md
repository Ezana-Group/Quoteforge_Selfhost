# Extras

Not part of the supported release — kept here for anyone who wants to build
their own on top of them.

## installer.nsi.example

An NSIS script for building a Windows installer (Start Menu entry, desktop
shortcut, uninstaller in "Apps & Features"). It expects a compiled
`Run-Calculator.exe` (e.g. via `pkg` or `nexe`) which isn't part of this
repo — there's no build pipeline included for producing one. If you want a
signed, installable Windows build, this script is a starting point, but
you'll need to set up that packaging step yourself.

For most people, `Start-QuoteForge-Pro.bat` (portable, no install) or the
Docker self-host option in the main README will be simpler.
