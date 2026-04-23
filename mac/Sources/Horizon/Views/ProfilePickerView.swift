import SwiftUI

/// "Who's watching?" screen. Grid of large coloured avatars + a dashed
/// "Add profile" tile. Mirrors the web ProfilePicker.
struct ProfilePickerView: View {
    @Environment(HorizonClient.self) private var client

    @State private var adding = false
    @State private var newName = ""

    var body: some View {
        ZStack {
            Color.horizonBgDeep.ignoresSafeArea()
            RadialGradient(colors: [Color.horizonAccent.opacity(0.18), .clear],
                           center: UnitPoint(x: 0.3, y: 0.2),
                           startRadius: 0, endRadius: 720)
            RadialGradient(colors: [Color(red: 227/255, green: 73/255, blue: 137/255).opacity(0.12), .clear],
                           center: UnitPoint(x: 0.7, y: 0.8),
                           startRadius: 0, endRadius: 720)

            VStack(spacing: 64) {
                VStack(spacing: 8) {
                    HorizonMark(size: 44)
                        .padding(.bottom, 16)
                    Text("Who’s watching?")
                        .font(.horizon(size: 48, weight: .heavy))
                        .kerning(-1.44)
                        .foregroundStyle(.white)
                    Text("Pick a profile to continue")
                        .font(.horizon(size: 15, weight: .regular))
                        .foregroundStyle(.horizonMutedHi)
                }

                HStack(alignment: .top, spacing: 48) {
                    ForEach(client.users) { user in
                        profileTile(user)
                    }
                    addTile
                }

                if adding {
                    HStack(spacing: 12) {
                        TextField("Profile name", text: $newName)
                            .textFieldStyle(.plain)
                            .font(.horizon(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .frame(height: 52)
                            .background(Color.horizonSurface, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .strokeBorder(Color.horizonBorderHi)
                            )
                            .onSubmit { create() }

                        Button("Create", action: create)
                            .buttonStyle(.plain)
                            .font(.horizon(size: 14, weight: .bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 22)
                            .frame(height: 52)
                            .background(Color.horizonAccent, in: RoundedRectangle(cornerRadius: 12))
                            .shadow(color: .horizonAccent.opacity(0.66), radius: 20, y: 10)
                            .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .frame(maxWidth: 420)
                }
            }
            .padding(.vertical, 80)
        }
    }

    private func profileTile(_ user: User) -> some View {
        Button {
            client.setActiveUser(user)
        } label: {
            VStack(spacing: 16) {
                ProfileAvatar(user: user, size: 180)
                Text(user.name)
                    .font(.horizon(size: 20, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .buttonStyle(.plain)
    }

    private var addTile: some View {
        Button {
            withAnimation { adding.toggle() }
        } label: {
            VStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 40, style: .continuous)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 6]))
                        .foregroundStyle(Color.horizonBorderHi)
                    Image(systemName: "plus")
                        .font(.system(size: 42, weight: .regular))
                        .foregroundStyle(Color.horizonMutedHi)
                }
                .frame(width: 180, height: 180)
                Text("Add profile")
                    .font(.horizon(size: 18, weight: .regular))
                    .foregroundStyle(Color.horizonMutedHi)
            }
        }
        .buttonStyle(.plain)
    }

    private func create() {
        let trimmed = newName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        Task {
            if let u = try? await client.api.createUser(name: trimmed, avatar: nil) {
                await client.reloadUsers()
                await MainActor.run {
                    newName = ""
                    adding = false
                    client.setActiveUser(u)
                }
            }
        }
    }
}
