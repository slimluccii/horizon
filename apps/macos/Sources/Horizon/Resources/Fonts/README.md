# Fonts

Drop Nunito `.ttf` files here for embedded typography. The app falls back
to the SF Pro Rounded system fallback if they're missing, but the brand
look assumes Nunito.

Required files (download from
<https://fonts.google.com/specimen/Nunito> as a .zip, then copy):

- `Nunito-Regular.ttf`
- `Nunito-SemiBold.ttf`
- `Nunito-Bold.ttf`
- `Nunito-ExtraBold.ttf`
- `Nunito-Black.ttf`

`FontLoader.registerEmbeddedFonts()` (called from `HorizonApp.init`)
walks this list and registers any that are present with
`CTFontManagerRegisterFontsForURL`. Missing files are silently skipped.

Xcode 15+ bundles this whole directory as an in-target resource via the
`.process("Resources")` rule in `Package.swift`.
