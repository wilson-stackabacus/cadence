import SwiftUI

/// Calendly-style scheduling: pick a meeting type, see open slots computed from your
/// availability minus Google Calendar busy times and your own timed tasks, then book
/// (Google sends the invitee an invitation email).
struct BookingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar

    struct Slot: Identifiable, Hashable {
        let start: Date
        let end: Date
        var id: Date { start }
    }

    @State private var meetingID: UUID?
    @State private var busy: [DateInterval] = []
    @State private var loading = false
    @State private var booking: Slot?
    @State private var banner: String?

    private var meeting: MeetingType {
        store.settings.meetingTypes.first { $0.id == meetingID } ?? store.settings.meetingTypes.first
            ?? MeetingType(name: "Meeting", minutes: 30)
    }

    var body: some View {
        let slots = computeSlots()
        VStack(spacing: 0) {
            ScreenHeader(title: "Booking", subtitle: "Share open times and book meetings straight into Google Calendar.") {
                Button { Task { await loadBusy() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(loading)
                Button { copyAvailability(slots) } label: { Label("Copy availability", systemImage: "doc.on.doc") }
                    .disabled(slots.isEmpty)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !google.isConnected {
                        HStack(spacing: 12) {
                            Image(systemName: "calendar.badge.exclamationmark").font(.title2).foregroundStyle(.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Google Calendar isn't connected").font(.callout.weight(.semibold))
                                Text("Slots only account for your Cadence tasks, and bookings are saved as Cadence tasks without sending invites.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Connect in Settings") { model.screen = .settings }
                        }
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.10)))
                    }
                    if let banner {
                        Label(banner, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Color.green.opacity(0.10)))
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        SectionTitle(text: "Meeting type", symbol: "person.2")
                        HStack(spacing: 10) {
                            ForEach(store.settings.meetingTypes) { mt in
                                let on = mt.id == meeting.id
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(mt.name).font(.callout.weight(.semibold))
                                        Spacer()
                                        if on { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
                                    }
                                    Label("\(mt.minutes) min", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                                    if !mt.details.isEmpty {
                                        Text(mt.details).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                                .padding(12)
                                .frame(width: 190, height: 86, alignment: .topLeading)
                                .background(RoundedRectangle(cornerRadius: 10).fill(on ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor)))
                                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? Color.accentColor : Color.primary.opacity(0.08), lineWidth: on ? 1.5 : 1))
                                .contentShape(Rectangle())
                                .onTapGesture { meetingID = mt.id }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            SectionTitle(text: "Open slots", symbol: "calendar.badge.clock")
                            if loading { ProgressView().controlSize(.small) }
                            Spacer()
                            Text(availabilitySummary).font(.caption).foregroundStyle(.secondary)
                            Button("Edit hours") { model.screen = .settings }.controlSize(.small)
                        }
                        if slots.isEmpty {
                            Text("No open slots in the next \(store.settings.availability.daysAhead) days with your current availability.")
                                .foregroundStyle(.secondary).padding(.vertical, 20)
                        } else {
                            ScrollView(.horizontal) {
                                HStack(alignment: .top, spacing: 10) {
                                    ForEach(slots, id: \.0) { day, daySlots in
                                        VStack(spacing: 6) {
                                            VStack(spacing: 0) {
                                                Text(day.formatted(.dateTime.weekday(.abbreviated))).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                                Text(day.formatted(.dateTime.month(.abbreviated).day())).font(.callout.weight(.semibold))
                                            }
                                            .padding(.bottom, 4)
                                            ForEach(daySlots) { slot in
                                                Button { booking = slot } label: {
                                                    Text(timeString(slot.start)).font(.callout.monospacedDigit()).frame(width: 96)
                                                }
                                                .buttonStyle(.bordered)
                                                .tint(.accentColor)
                                            }
                                        }
                                        .padding(10)
                                        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                                    }
                                }
                                .padding(.bottom, 8)
                            }
                        }
                    }

                    Text("Cadence runs on your Mac, so it can't host a public booking link the way Calendly does. Use “Copy availability” to paste your open times into an email or chat, then book the slot the other person picks. For a public link, Google Calendar's own Appointment Schedules feature works alongside this.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(22)
            }
        }
        .sheet(item: $booking) { slot in
            BookingSheet(slot: slot, meeting: meeting) { message in
                booking = nil
                if let message { banner = message; Task { await loadBusy() } }
            }
        }
        .task(id: google.isConnected) { await loadBusy() }
    }

    private var availabilitySummary: String {
        let a = store.settings.availability
        let days = a.weekdays.sorted().map { Calendar.current.shortWeekdaySymbols[$0 - 1] }.joined(separator: " ")
        return "\(days) · \(timeString(minutes: a.startMinutes))–\(timeString(minutes: a.endMinutes))"
    }

    private func loadBusy() async {
        guard google.isConnected else { busy = []; return }
        loading = true
        defer { loading = false }
        let now = Date()
        do {
            busy = try await google.busyIntervals(from: now, to: now.startOfDay.adding(days: store.settings.availability.daysAhead + 1))
        } catch {
            google.lastError = error.localizedDescription
        }
    }

    private func computeSlots() -> [(Date, [Slot])] {
        let a = store.settings.availability
        let dur = meeting.minutes
        let step = min(dur, 30)
        let earliest = Date().addingTimeInterval(Double(a.minNoticeHours) * 3600)
        let buffer = Double(a.bufferMinutes * 60)
        var result: [(Date, [Slot])] = []
        for offset in 0..<a.daysAhead {
            let day = Date().startOfDay.adding(days: offset)
            guard a.weekdays.contains(Calendar.current.component(.weekday, from: day)) else { continue }
            // Busy = Google free/busy + timed Cadence tasks that day.
            var blocked = busy
            for occ in store.occurrences(on: day) {
                if let s = occ.start, let e = occ.end { blocked.append(DateInterval(start: s, end: e)) }
            }
            var daySlots: [Slot] = []
            var m = a.startMinutes
            while m + dur <= a.endMinutes {
                let s = dayAt(day, minutes: m)
                let e = s.adding(minutes: dur)
                let padded = DateInterval(start: s.addingTimeInterval(-buffer), end: e.addingTimeInterval(buffer))
                if s >= earliest && !blocked.contains(where: { $0.start < padded.end && $0.end > padded.start }) {
                    daySlots.append(Slot(start: s, end: e))
                }
                m += step
            }
            if !daySlots.isEmpty { result.append((day, daySlots)) }
        }
        return result
    }

    private func copyAvailability(_ slots: [(Date, [Slot])]) {
        let tz = TimeZone.current.abbreviation() ?? TimeZone.current.identifier
        var text = "Here are some times that work for a \(meeting.minutes)-minute \(meeting.name.lowercased()) (\(tz)):\n\n"
        for (day, daySlots) in slots.prefix(5) {
            let times = daySlots.prefix(8).map { timeString($0.start) }.joined(separator: ", ")
            text += "• \(day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())): \(times)\n"
        }
        text += "\nLet me know which works and I'll send an invite."
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        banner = "Availability copied to the clipboard."
    }
}

private struct BookingSheet: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    let slot: BookingView.Slot
    let meeting: MeetingType
    let done: (String?) -> Void

    @State private var name = ""
    @State private var email = ""
    @State private var title = ""
    @State private var notes = ""
    @State private var addMeet = true
    @State private var working = false
    @State private var error: String?

    private var emailValid: Bool {
        let e = email.trimmingCharacters(in: .whitespaces)
        return e.contains("@") && e.split(separator: "@").last?.contains(".") == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Book \(meeting.name)").font(.title3.bold())
                Label("\(slot.start.formatted(.dateTime.weekday(.wide).month(.wide).day())) · \(timeString(slot.start))–\(timeString(slot.end))",
                      systemImage: "calendar.badge.clock")
                    .foregroundStyle(.secondary)
            }
            .padding([.horizontal, .top], 20)
            Form {
                TextField("Invitee name", text: $name)
                TextField("Invitee email", text: $email)
                TextField("Event title", text: $title, prompt: Text(defaultTitle))
                TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...4)
                if google.isConnected {
                    Toggle("Add a Google Meet link", isOn: $addMeet)
                    Text("Google emails an invitation to the invitee.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Not connected to Google: this is saved as a Cadence task only.").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button("Cancel") { done(nil) }.keyboardShortcut(.cancelAction)
                Button("Book") { Task { await book() } }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || (google.isConnected && !emailValid) || working)
            }
            .padding(16)
        }
        .frame(width: 480)
        .onAppear { addMeet = meeting.addMeetLink }
    }

    private var defaultTitle: String {
        let n = name.trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? meeting.name : "\(meeting.name) with \(n)"
    }

    private func book() async {
        working = true
        defer { working = false }
        let finalTitle = title.trimmingCharacters(in: .whitespaces).isEmpty ? defaultTitle : title
        if google.isConnected {
            do {
                try await google.create(NewGoogleEvent(
                    title: finalTitle, details: notes, start: slot.start, end: slot.end,
                    attendees: [(email.trimmingCharacters(in: .whitespaces), name)], addMeetLink: addMeet))
                done("Booked “\(finalTitle)” — invitation sent to \(email).")
            } catch {
                self.error = error.localizedDescription
            }
        } else {
            store.upsert(PlanTask(title: finalTitle, notes: notes, startDate: slot.start.startOfDay,
                                  timeMinutes: slot.start.minutesSinceMidnight, durationMinutes: meeting.minutes,
                                  reminderOffsets: [10], channels: store.settings.defaultChannels, color: .purple))
            done("Saved “\(finalTitle)” to your Cadence calendar.")
        }
    }
}
