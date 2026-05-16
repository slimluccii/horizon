import SwiftUI

/// Design tokens ported from the web app (`app/src/styles/tokens.css`).
/// Navy base + Plex-Luuk accent blue. Keep these in sync if the web palette
/// shifts — a single source of truth lives in the design bundle README.
extension Color {
    static let horizonBg        = Color(red:   0/255, green: 21/255, blue: 35/255)
    static let horizonBgDeep    = Color(red:   0/255, green: 13/255, blue: 22/255)
    static let horizonSurface   = Color(red:  10/255, green: 30/255, blue: 48/255)
    static let horizonSurface2  = Color(red:  15/255, green: 38/255, blue: 58/255)
    static let horizonBorder    = Color(red:  27/255, green: 38/255, blue: 59/255)
    static let horizonBorderHi  = Color(red:  45/255, green: 63/255, blue: 85/255)
    static let horizonMuted     = Color(red: 128/255, green:128/255, blue:128/255)
    static let horizonMutedHi   = Color(red: 162/255, green:176/255, blue:189/255)
    static let horizonTextSoft  = Color(red: 230/255, green:234/255, blue:245/255)
    static let horizonAccent    = Color(red:   0/255, green:158/255, blue:255/255)
    static let horizonAccentDim = Color(red:   0/255, green:158/255, blue:255/255, opacity: 0.18)
    static let horizonDanger    = Color(red: 255/255, green: 91/255, blue: 88/255)
    static let horizonGood      = Color(red:  31/255, green:164/255, blue:124/255)
    static let horizonImdb      = Color(red: 245/255, green:197/255, blue: 24/255)
    static let horizonPopcorn   = Color(red: 255/255, green:183/255, blue: 65/255)
}

/// Expose the Horizon palette through the generic `ShapeStyle` surface so
/// `.foregroundStyle(.horizonAccent)` shorthand works wherever SwiftUI accepts
/// a shape style (Text / Image / stroke / fill / etc.).
extension ShapeStyle where Self == Color {
    static var horizonBg:        Color { .horizonBg }
    static var horizonBgDeep:    Color { .horizonBgDeep }
    static var horizonSurface:   Color { .horizonSurface }
    static var horizonSurface2:  Color { .horizonSurface2 }
    static var horizonBorder:    Color { .horizonBorder }
    static var horizonBorderHi:  Color { .horizonBorderHi }
    static var horizonMuted:     Color { .horizonMuted }
    static var horizonMutedHi:   Color { .horizonMutedHi }
    static var horizonTextSoft:  Color { .horizonTextSoft }
    static var horizonAccent:    Color { .horizonAccent }
    static var horizonAccentDim: Color { .horizonAccentDim }
    static var horizonDanger:    Color { .horizonDanger }
    static var horizonGood:      Color { .horizonGood }
    static var horizonImdb:      Color { .horizonImdb }
    static var horizonPopcorn:   Color { .horizonPopcorn }
}
