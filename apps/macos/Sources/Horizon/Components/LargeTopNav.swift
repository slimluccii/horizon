import SwiftUI

enum TabKey: String, CaseIterable, Hashable {
    case home = "Home"
    case movies = "Movies"
    case series = "Series"
    case collections = "Collections"
}

/// Sticky 72pt top chrome. Over hero screens pass `transparent: true` so the
/// art bleeds behind it with a dark-fade scrim; everywhere else the bar is
/// solid with a hairline border.
struct LargeTopNav: View {
    var active: TabKey? = nil
    var transparent: Bool = false
    var onBack: (() -> Void)? = nil
    var onTabChange: ((TabKey) -> Void)? = nil

    @Environment(HorizonClient.self) private var client
    @State private var showProfileMenu = false

    var body: some View {
        ZStack(alignment: .top) {
            if transparent {
                // Gradient scrim — guarantees chrome legibility on bright posters.
                LinearGradient(
                    stops: [
                        .init(color: .black.opacity(0.78), location: 0),
                        .init(color: .black.opacity(0.35), location: 0.6),
                        .init(color: .clear, location: 1)
                    ],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: 160)
                .allowsHitTesting(false)
            } else {
                Rectangle()
                    .fill(Color.horizonBgDeep.opacity(0.82))
                    .frame(height: 72)
                    .background(.ultraThinMaterial)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1)
                    }
            }

            HStack(spacing: 24) {
                if let onBack = onBack {
                    ChromeButton(icon: "chevron.left") { onBack() }
                } else {
                    HorizonMark(size: 36)
                }

                HStack(spacing: 4) {
                    ForEach(TabKey.allCases, id: \.self) { tab in
                        tabButton(tab)
                    }
                }
                .padding(.leading, 8)

                Spacer()

                ChromeButton(icon: "magnifyingglass") { /* future search */ }
                profileButton
            }
            .padding(.horizontal, 32)
            .frame(height: 72)
        }
        .frame(height: 72)
    }

    // MARK: - Tab

    @ViewBuilder
    private func tabButton(_ tab: TabKey) -> some View {
        Button {
            onTabChange?(tab)
        } label: {
            Text(tab.rawValue)
                .font(.horizon(size: 14, weight: active == tab ? .bold : .semibold))
                .kerning(-0.14)
                .foregroundStyle(active == tab ? Color.black : .white)
                .shadow(color: .black.opacity(transparent && active != tab ? 0.75 : 0),
                        radius: 3, y: 1)
                .padding(.horizontal, 16)
                .frame(height: 36)
                .background(
                    Capsule(style: .continuous)
                        .fill(active == tab ? Color.white : Color.clear)
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Profile

    @ViewBuilder
    private var profileButton: some View {
        if let user = client.activeUser {
            Menu {
                Button("Switch profile") {
                    client.setActiveUser(nil)
                }
                Divider()
                Button("Delete profile", role: .destructive) {
                    Task { await deleteActive() }
                }
            } label: {
                ProfileAvatar(user: user, size: 40)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    private func deleteActive() async {
        guard let user = client.activeUser else { return }
        try? await client.api.deleteUser(user.id)
        client.setActiveUser(nil)
        await client.reloadUsers()
    }
}

// MARK: - Chrome button

/// Circular glass button used in the top nav (search, back) + on hero bleeds.
struct ChromeButton: View {
    let icon: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color(red: 20/255, green: 30/255, blue: 42/255).opacity(hovering ? 0.95 : 0.85))
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.22)))
                    .background(.ultraThinMaterial, in: Circle())
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
