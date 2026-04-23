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
        for name in names {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf") else {
                // Not fatal — SF Pro fallback below handles the missing-font case.
                continue
            }
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
        }
    }
}

/// Typography helpers. Nunito is the brand; SF Pro Rounded is a reasonable
/// system fallback if the font files aren't bundled.
extension Font {
    static func horizon(size: CGFloat, weight: Weight = .regular) -> Font {
        let nunitoName: String = {
            switch weight {
            case .regular:  return "Nunito-Regular"
            case .semibold: return "Nunito-SemiBold"
            case .bold:     return "Nunito-Bold"
            case .heavy:    return "Nunito-ExtraBold"
            case .black:    return "Nunito-Black"
            default:        return "Nunito-Regular"
            }
        }()
        return .custom(nunitoName, size: size, relativeTo: .body)
            .weight(weight)
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
