import SwiftUI

/// Deterministic per-user color derived from the name, so each profile
/// renders a distinct chip + avatar background without an extra server field.
enum UserPalette {
    private static let colors: [Color] = [
        Color(red: 0/255,   green: 137/255, blue: 255/255),
        Color(red: 227/255, green:  73/255, blue: 137/255),
        Color(red:  31/255, green: 164/255, blue: 124/255),
        Color(red: 245/255, green: 197/255, blue:  24/255),
        Color(red: 157/255, green:  92/255, blue: 255/255),
        Color(red: 250/255, green: 106/255, blue:  60/255),
    ]

    static func color(for name: String) -> Color {
        var hash = 0
        for scalar in name.unicodeScalars {
            hash = (hash &* 31) &+ Int(scalar.value)
        }
        return colors[abs(hash) % colors.count]
    }
}

/// Circular avatar with the user's emoji (if set) or name initial. Size is
/// configurable for the picker (180pt) vs. nav badge (40pt).
struct ProfileAvatar: View {
    let user: User
    var size: CGFloat = 60

    var body: some View {
        let color = UserPalette.color(for: user.name)
        let label = user.avatar ?? String(user.name.prefix(1)).uppercased()
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(color)
                .shadow(color: color.opacity(0.4), radius: size * 0.3, x: 0, y: size * 0.1)
            Text(label)
                .font(.horizon(size: size * 0.44, weight: .black))
                .kerning(-0.03 * size)
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .overlay(
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .strokeBorder(Color.white.opacity(0.1), lineWidth: 1)
        )
    }
}
