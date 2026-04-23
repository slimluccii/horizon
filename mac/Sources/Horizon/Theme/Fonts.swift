import SwiftUI
import AppKit
import CoreText

/// Loads embedded Nunito `.ttf` files at app launch. Drop the font files under
/// `Sources/Horizon/Resources/Fonts/` and Xcode will bundle them via the
/// Package.swift `.process("Resources")` rule.
enum FontLoader {
    static func registerEmbeddedFonts() {
        let names = [
            "Nunito-Regular",
            "Nunito-SemiBold",
            "Nunito-Bold",
            "Nunito-ExtraBold",
            "Nunito-Black",
        ]
        var loadedAny = false
        for name in names {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf") else {
                // Not fatal — system fallback in `Font.horizon(size:weight:)` handles it.
                continue
            }
            var error: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                loadedAny = true
            }
        }
        // Mark the state so the Font helper knows whether to use .custom() or
        // fall through to .system(). Avoids the "can't update weight" warnings
        // that SwiftUI emits when applying .weight() to a named custom face.
        NunitoState.available = loadedAny
    }
}

/// Tracks whether the Nunito TTFs loaded successfully. When false, we render
/// via the system font with an explicit weight so the UI still has the right
/// hierarchy — just not the Horizon brand face.
private enum NunitoState {
    /// Set by FontLoader at launch. `nil` until bootstrap runs.
    static var available: Bool = false
}

/// Typography helpers. Nunito is the brand; system font (SF Pro) serves as
/// the fallback when the TTFs aren't bundled.
///
/// IMPORTANT: when we use a named custom face we do NOT apply `.weight()` on
/// top. The face name already encodes the weight ("Nunito-Bold" is bold).
/// Layering `.weight()` makes SwiftUI emit "Unable to update Font Descriptor's
/// weight" warnings because it can't modify the already-resolved weight of a
/// custom face. The system-font fallback DOES take `.weight()` because there
/// the face name is generic.
extension Font {
    static func horizon(size: CGFloat, weight: Weight = .regular) -> Font {
        if NunitoState.available {
            let name: String
            switch weight {
            case .regular:  name = "Nunito-Regular"
            case .semibold: name = "Nunito-SemiBold"
            case .bold:     name = "Nunito-Bold"
            case .heavy:    name = "Nunito-ExtraBold"
            case .black:    name = "Nunito-Black"
            default:        name = "Nunito-Regular"
            }
            return .custom(name, size: size, relativeTo: .body)
        }
        // System fallback: weight adjustment on the generic face is fine.
        return .system(size: size, weight: weight, design: .rounded)
    }
}

/// Small-caps eyebrow style used across the UI ("FEATURED · JUST ADDED", "UP NEXT", …).
struct EyebrowStyle: ViewModifier {
    var color: Color = .horizonAccent
    func body(content: Content) -> some View {
        content
            .font(.horizon(size: 11, weight: .heavy))
            .tracking(3)
            .textCase(.uppercase)
            .foregroundStyle(color)
    }
}

extension View {
    func eyebrow(_ color: Color = .horizonAccent) -> some View {
        modifier(EyebrowStyle(color: color))
    }
}
