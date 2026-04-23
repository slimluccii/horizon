import SwiftUI

/// Accent-blue rounded square with the white Horizon L glyph. Used in the
/// top nav + setup / profile picker hero slots.
struct HorizonMark: View {
    var size: CGFloat = 40
    var withText: Bool = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                    .fill(Color.horizonAccent)
                    .shadow(color: .horizonAccent.opacity(0.4), radius: 24, x: 0, y: 10)
                LogoPath()
                    .fill(.white)
                    .frame(width: size * 0.6, height: size * 0.6)
            }
            .frame(width: size, height: size)
            if withText {
                Text("Horizon")
                    .font(.horizon(size: size * 0.5, weight: .heavy))
                    .kerning(-0.02 * size)
                    .foregroundStyle(.white)
            }
        }
    }
}

/// Hand-traced L glyph sourced from the Horizon design bundle.
private struct LogoPath: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let w = rect.width / 100, h = rect.height / 100
        p.move(to:    CGPoint(x: 22 * w, y: 18 * h))
        p.addLine(to: CGPoint(x: 22 * w, y: 82 * h))
        p.addLine(to: CGPoint(x: 78 * w, y: 82 * h))
        p.addLine(to: CGPoint(x: 78 * w, y: 66 * h))
        p.addLine(to: CGPoint(x: 38 * w, y: 66 * h))
        p.addLine(to: CGPoint(x: 38 * w, y: 18 * h))
        p.closeSubpath()
        return p
    }
}
