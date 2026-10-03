import SwiftUI

/// Your open time for the next 7 days: open hours minus closed tasks/events (and Google busy times).
/// Click any green stretch to book a time in it; with Google connected the booking becomes a synced
/// Google event and an optional invitee gets an invitation.
struct BookingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    @EnvironmentObject private var calendly: CalendlyService
    @State private var copiedLink: String?
    @State private var busy: [DateInterval] = []
    @State private var loading = false
    @State private var booking: BookRequest?
    @State private var banner: String?

    struct BookRequest: Identifiable {
        let start: Date
        let rangeEnd: Date
        var id: Date { start }
    }

    /// One day of the visualization.
    struct DayPlan: Identifiable {
        let day: Date
        let timed: [WeekView.Placed]
        let allDay: [CalendarItem]
        let extra: [DateInterval]   // Google busy times Cadence has no item for
        let open: [DateInterval]
        var total: TimeInterval { open.reduce(0) { $0 + $1.duration } }
        var id: Date { day }
    }

    private let hourHeight: CGFloat = 40
    private let gutter: CGFloat = 52

    var body: some View {
        let week = Self.plans(store: store, google: google, busy: busy)
        let total = week.reduce(0) { $0 + $1.total }
        VStack(spacing: 0) {
            ScreenHeader(title: "Booking", subtitle: "Your open time for the next 7 days. Click any green stretch to book it.") {
                Button { Task { await loadBusy() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(loading)
                Button { copyOpenTimes(week) } label: { Label("Copy open times", systemImage: "doc.on.doc") }
                    .disabled(total == 0)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !google.isConnected {
                        HStack(spacing: 12) {
                            Image(systemName: "calendar.badge.exclamationmark").font(.title2).foregroundStyle(.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Google Calendar isn't connected").font(.callout.weight(.semibold))
                                Text("Open time only accounts for what's in Cadence, and bookings are saved as Cadence events without sending invites.")
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
                            .transition(.opacity)
                    }

                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(durationText(total)).font(.system(size: 26, weight: .bold).monospacedDigit()).foregroundStyle(.green)
                        Text("open this week").foregroundStyle(.secondary)
                        if loading { ProgressView().controlSize(.small) }
                        Spacer()
                        Text(hoursSummary).font(.caption).foregroundStyle(.secondary)
                        Button("Edit hours") { model.screen = .settings }.controlSize(.small)
                    }
                    legend
                    grid(week)

                    if calendly.isConnected && !calendly.eventTypes.isEmpty { calendlyLinks }

                    Text("Closed items take their time out of your open time; open ones are just for info. Events you make in Cadence start out closed and tasks start out open — change it in any item's editor. “Copy open times” puts the list on your clipboard to paste into an email.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(22)
            }
        }
        .sheet(item: $booking) { req in
            BookingSheet(request: req) { message in
                booking = nil
                if let message { withAnimation { banner = message }; Task { await loadBusy() } }
            }
        }
        .onAppear { google.ensure(from: Date().startOfDay, to: Date().startOfDay.adding(days: 8)) }
        .task(id: google.isConnected) { await loadBusy() }
    }

    // MARK: Pieces

    private var legend: some View {
        HStack(spacing: 16) {
            legendItem("Open time") {
                RoundedRectangle(cornerRadius: 3).fill(Color.green.opacity(0.25))
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.green, lineWidth: 1))
            }
            legendItem("Closed — blocks time") { RoundedRectangle(cornerRadius: 3).fill(Color.accentColor.opacity(0.6)) }
            legendItem("Open — just for info") {
                RoundedRectangle(cornerRadius: 3).fill(.clear).background(OpenStripes(color: .secondary, opacity: 0.5))
                    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1, dash: [2, 2])))
            }
            legendItem("Outside your open hours") {
                RoundedRectangle(cornerRadius: 3).fill(.clear).background(OpenStripes(color: .secondary, opacity: 0.25))
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    private func legendItem<S: View>(_ text: String, @ViewBuilder swatch: () -> S) -> some View {
        HStack(spacing: 6) { swatch().frame(width: 14, height: 10).clipShape(RoundedRectangle(cornerRadius: 3)); Text(text) }
    }

    private func grid(_ week: [DayPlan]) -> some View {
        let (h0, h1) = hourRange(week)
        let height = CGFloat(h1 - h0) * hourHeight
        return GeometryReader { geo in
            let colW = max(104, (geo.size.width - gutter - 8) / 7)
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(spacing: 0) {
                    // Day headers
                    HStack(spacing: 0) {
                        Color.clear.frame(width: gutter, height: 1)
                        ForEach(week) { d in
                            VStack(spacing: 1) {
                                Text(d.day.isToday ? "TODAY" : d.day.formatted(.dateTime.weekday(.abbreviated)).uppercased())
                                    .font(.caption2.weight(.semibold)).foregroundStyle(d.day.isToday ? Color.accentColor : .secondary)
                                Text(d.day.formatted(.dateTime.day())).font(.title3.weight(.semibold))
                                    .foregroundStyle(d.day.isToday ? Color.accentColor : .primary)
                                Text(d.total > 0 ? "\(durationText(d.total)) open" : "no open time")
                                    .font(.caption2).foregroundStyle(d.total > 0 ? Color.green : .secondary)
                            }
                            .frame(width: colW)
                        }
                    }
                    .padding(.vertical, 6)
                    Divider()
                    // All-day row
                    HStack(alignment: .top, spacing: 0) {
                        Text("all day").font(.system(size: 9)).foregroundStyle(.secondary)
                            .frame(width: gutter - 8, alignment: .trailing).padding(.trailing, 8)
                        ForEach(week) { d in
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(d.allDay) { it in AllDayChip(item: it) }
                            }
                            .padding(3)
                            .frame(width: colW, alignment: .topLeading)
                            .frame(minHeight: 24, alignment: .top)
                            .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.08)).frame(width: 1) }
                        }
                    }
                    Divider()
                    // Timeline
                    HStack(alignment: .top, spacing: 0) {
                        VStack(spacing: 0) {
                            ForEach(h0..<h1, id: \.self) { h in
                                Text(timeString(minutes: h * 60)).font(.system(size: 9)).foregroundStyle(.secondary)
                                    .frame(width: gutter - 8, height: hourHeight, alignment: .topTrailing)
                                    .padding(.trailing, 8).offset(y: -6)
                            }
                        }
                        ForEach(week) { d in column(d, h0: h0, h1: h1, width: colW).frame(width: colW, height: height) }
                    }
                    .padding(.top, 6)
                }
                .padding(.trailing, 8)
                .padding(.bottom, 8)
            }
        }
        .frame(height: height + 110)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.08)))
    }

    private func column(_ d: DayPlan, h0: Int, h1: Int, width: CGFloat) -> some View {
        let a = store.settings.availability
        let top = dayAt(d.day, minutes: h0 * 60)
        let y: (Date) -> CGFloat = { CGFloat($0.timeIntervalSince(top) / 3600) * hourHeight }
        let maxY = CGFloat(h1 - h0) * hourHeight
        func band(_ s: Date, _ e: Date) -> (CGFloat, CGFloat)? {
            let t = max(0, y(s)), b = min(maxY, y(e))
            return b > t ? (t, max(16, b - t - 1)) : nil
        }
        let off = !a.weekdays.contains(Calendar.current.component(.weekday, from: d.day))
        var offBands: [(CGFloat, CGFloat)] = []
        if off { offBands = [(0, maxY)] } else {
            if let b = band(top, dayAt(d.day, minutes: a.startMinutes)) { offBands.append(b) }
            if let b = band(dayAt(d.day, minutes: a.endMinutes), d.day.adding(days: 1)) { offBands.append(b) }
        }
        return ZStack(alignment: .topLeading) {
            // Hour lines
            VStack(spacing: 0) {
                ForEach(h0..<h1, id: \.self) { _ in
                    Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1).frame(maxHeight: .infinity, alignment: .top)
                }
            }
            ForEach(Array(offBands.enumerated()), id: \.offset) { _, b in
                OpenStripes(color: .secondary, opacity: 0.14).frame(width: width, height: b.1).offset(y: b.0)
            }
            if d.day.isToday, let b = band(top, Date()) {
                Color.secondary.opacity(0.08).frame(width: width, height: b.1).offset(y: b.0).allowsHitTesting(false)
            }
            ForEach(d.open, id: \.start) { r in
                if let b = band(r.start, r.end) {
                    OpenBlock(range: r, height: b.1) { start in booking = BookRequest(start: start, rangeEnd: r.end) }
                        .frame(width: width - 6, height: b.1).offset(x: 3, y: b.0)
                }
            }
            ForEach(d.extra, id: \.start) { r in
                if let b = band(r.start, r.end) {
                    Text("Busy").font(.system(size: 10, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(width: width - 4, height: b.1, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.gray.opacity(0.75)))
                        .help("Busy in Google Calendar")
                        .offset(x: 2, y: b.0)
                }
            }
            ForEach(d.timed) { p in
                if let b = band(p.start, p.end) {
                    let w = (width - 4) / CGFloat(p.lanes)
                    TimedBlock(item: p.item, height: b.1)
                        .frame(width: w - 2, height: b.1)
                        .offset(x: 2 + CGFloat(p.lane) * w, y: b.0)
                }
            }
            if d.day.isToday {
                let ny = y(Date())
                if ny > 0 && ny < maxY {
                    Rectangle().fill(.red).frame(width: width, height: 1.5).offset(y: ny).allowsHitTesting(false)
                }
            }
        }
        .frame(width: width, height: maxY, alignment: .topLeading)
        .clipped()
        .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.08)).frame(width: 1) }
    }

    private var calendlyLinks: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle(text: "Your Calendly links", symbol: "link")
            Text("Public links anyone can book from. Booked meetings land on your calendar automatically.")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(calendly.eventTypes) { t in
                HStack(spacing: 10) {
                    Circle().fill(t.color.flatMap(Color.init(hex:)) ?? .purple).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(t.name).font(.callout.weight(.medium))
                        Text("\(t.minutes) min · \(t.url.absoluteString)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Button(copiedLink == t.id ? "Copied" : "Copy link") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(t.url.absoluteString, forType: .string)
                        withAnimation { copiedLink = t.id }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { withAnimation { if copiedLink == t.id { copiedLink = nil } } }
                    }
                    Link(destination: t.url) { Image(systemName: "arrow.up.right.square") }.help("Open")
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            }
        }
    }

    // MARK: Data

    private var hoursSummary: String {
        let a = store.settings.availability
        let days = a.weekdays.sorted().map { Calendar.current.shortWeekdaySymbols[$0 - 1] }.joined(separator: " ")
        return "Open hours: \(days) · \(timeString(minutes: a.startMinutes))–\(timeString(minutes: a.endMinutes))"
    }

    /// Your open hours, stretched to fit anything scheduled outside them.
    private func hourRange(_ week: [DayPlan]) -> (Int, Int) {
        let a = store.settings.availability
        var lo = a.startMinutes, hi = a.endMinutes
        for d in week {
            for p in d.timed {
                lo = min(lo, p.start.minutesSinceMidnight)
                hi = max(hi, p.end.isSameDay(d.day) ? p.end.minutesSinceMidnight : 1440)
            }
        }
        let h0 = lo / 60
        return (h0, max(h0 + 1, Int((Double(hi) / 60).rounded(.up))))
    }

    /// The next 7 days. `busy` is Google free/busy (pass [] when it isn't loaded).
    static func plans(store: Store, google: GoogleCalendar, busy: [DateInterval]) -> [DayPlan] {
        let a = store.settings.availability
        return (0..<7).map { i in
            let day = Date().startOfDay.adding(days: i)
            let next = day.adding(days: 1)
            var items: [WeekView.Placed] = []
            var allDay: [CalendarItem] = []
            for occ in store.occurrences(on: day) {
                if let s = occ.start, let e = occ.end { items.append(WeekView.Placed(item: .task(occ), start: s, end: e, day: day)) }
                else { allDay.append(.task(occ)) }
            }
            for ev in google.events(on: day) {
                if ev.isAllDay { allDay.append(.google(ev)) }
                else { items.append(WeekView.Placed(item: .google(ev), start: ev.start, end: ev.end, day: day)) }
            }
            var blocked = items.filter(\.item.isBusy).map { DateInterval(start: $0.start, end: $0.end) }
            if allDay.contains(where: \.isBusy) { blocked.append(DateInterval(start: day, end: next)) }
            // Google's free/busy also covers calendars and events Cadence doesn't show. Skip anything you've
            // marked open here (Google catches up a moment later) and anything already drawn.
            let openHere = Set(items.filter { !$0.item.isBusy }.map { "\($0.start.timeIntervalSince1970)|\($0.end.timeIntervalSince1970)" })
            var extra: [DateInterval] = []
            for b in busy {
                let s = max(b.start, day), e = min(b.end, next)
                guard e > s, !openHere.contains("\(b.start.timeIntervalSince1970)|\(b.end.timeIntervalSince1970)"),
                      !blocked.contains(where: { $0.start <= s && $0.end >= e }) else { continue }
                extra.append(DateInterval(start: s, end: e))
            }
            blocked += extra
            return DayPlan(day: day, timed: Self.lanes(items), allDay: allDay, extra: extra,
                           open: openRanges(on: day, hours: a, blocked: blocked))
        }
    }

    /// Side-by-side lanes for overlapping items (same rule as the week view).
    private static func lanes(_ input: [WeekView.Placed]) -> [WeekView.Placed] {
        let items = input.sorted { ($0.start, $1.end) < ($1.start, $0.end) }
        var result: [WeekView.Placed] = [], cluster: [WeekView.Placed] = [], laneEnds: [Date] = []
        var clusterEnd = Date.distantPast
        func flush() {
            let n = max(1, laneEnds.count)
            result += cluster.map { var p = $0; p.lanes = n; return p }
            cluster = []; laneEnds = []
        }
        for var p in items {
            if p.start >= clusterEnd { flush() }
            if let free = laneEnds.firstIndex(where: { $0 <= p.start }) { p.lane = free; laneEnds[free] = p.end }
            else { p.lane = laneEnds.count; laneEnds.append(p.end) }
            clusterEnd = max(clusterEnd, p.end)
            cluster.append(p)
        }
        flush()
        return result
    }

    private func loadBusy() async {
        guard google.isConnected else { busy = []; return }
        loading = true
        defer { loading = false }
        do {
            busy = try await google.busyIntervals(from: Date(), to: Date().startOfDay.adding(days: 8))
        } catch {
            google.lastError = error.localizedDescription
        }
    }

    private func copyOpenTimes(_ week: [DayPlan]) {
        let tz = TimeZone.current.abbreviation() ?? TimeZone.current.identifier
        var text = "Here's when I'm free over the next week (\(tz)):\n\n"
        for d in week where !d.open.isEmpty {
            let ranges = d.open.map { "\(timeString($0.start))–\(timeString($0.end))" }.joined(separator: ", ")
            text += "• \(d.day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())): \(ranges)\n"
        }
        text += "\nLet me know what works and I'll send an invite."
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        withAnimation { banner = "Open times copied to the clipboard." }
    }
}

func durationText(_ seconds: TimeInterval) -> String {
    let m = Int((seconds / 60).rounded()), h = m / 60
    return h > 0 ? (m % 60 > 0 ? "\(h)h \(m % 60)m" : "\(h)h") : "\(m)m"
}

/// A stretch of open time. Clicking books a time starting where you clicked (15-minute steps).
private struct OpenBlock: View {
    let range: DateInterval
    let height: CGFloat
    let onBook: (Date) -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(timeString(range.start))–\(timeString(range.end))").font(.system(size: 11, weight: .semibold)).foregroundStyle(.green)
            if height > 30 { Text("\(durationText(range.duration)) open").font(.system(size: 10)).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.green.opacity(hovering ? 0.28 : 0.16)))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.green.opacity(0.65), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hovering = h } }
        .gesture(SpatialTapGesture().onEnded { v in
            let q: TimeInterval = 15 * 60
            let at = range.start.addingTimeInterval(range.duration * Double(min(max(v.location.y / max(height, 1), 0), 1)))
            let latest = max(range.start, range.end.addingTimeInterval(-q))
            let snapped = Date(timeIntervalSince1970: (at.timeIntervalSince1970 / q).rounded(.down) * q)
            onBook(min(latest, max(range.start, snapped)))
        })
        .help("Open \(timeString(range.start))–\(timeString(range.end)) · click to book a time in it")
    }
}

/// An all-day item in the open-time grid: solid when closed (blocks the day), striped when open.
private struct AllDayChip: View {
    let item: CalendarItem
    @State private var showing = false

    var body: some View {
        Text(item.title)
            .font(.system(size: 10, weight: .medium)).lineLimit(1)
            .foregroundStyle(item.isBusy ? Color.white : Color.primary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 4).fill(item.isBusy ? item.color.opacity(0.8) : .clear))
            .background { if !item.isBusy { OpenStripes(color: item.color, opacity: 0.25) } }
            .overlay { if !item.isBusy { RoundedRectangle(cornerRadius: 4).strokeBorder(item.color, style: StrokeStyle(lineWidth: 1, dash: [2, 2])) } }
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .contentShape(Rectangle())
            .onTapGesture { showing = true }
            .help(item.isBusy ? "Closed: blocks the whole day" : "Open: just for info")
            .popover(isPresented: $showing, arrowEdge: .trailing) { ItemDetail(item: item) { showing = false } }
    }
}

private struct BookingSheet: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    let request: BookingView.BookRequest
    let done: (String?) -> Void

    @State private var title = ""
    @State private var start = Date()
    @State private var minutes = 30
    @State private var name = ""
    @State private var email = ""
    @State private var notes = ""
    @State private var addMeet = true
    @State private var working = false
    @State private var error: String?

    private static let lengths = [15, 30, 45, 60, 90, 120]

    private var emailOK: Bool {
        let e = email.trimmingCharacters(in: .whitespaces)
        return e.isEmpty || (e.contains("@") && e.split(separator: "@").last?.contains(".") == true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Book open time").font(.title3.bold())
                Label("\(request.start.formatted(.dateTime.weekday(.wide).month(.wide).day())) · open \(timeString(request.start))–\(timeString(request.rangeEnd))",
                      systemImage: "calendar.badge.clock")
                    .foregroundStyle(.secondary)
            }
            .padding([.horizontal, .top], 20)
            Form {
                TextField("Title", text: $title, prompt: Text("Meeting"))
                DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute)
                Picker("Length", selection: $minutes) {
                    ForEach(Self.lengths, id: \.self) { m in
                        Text(m < 60 ? "\(m) min" : (m % 60 == 0 ? "\(m / 60) hr" : "\(m / 60) hr \(m % 60) min")).tag(m)
                    }
                }
                TextField("Invitee name (optional)", text: $name)
                TextField("Invitee email (optional)", text: $email)
                TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...4)
                if google.isConnected {
                    Toggle("Add a Google Meet link", isOn: $addMeet)
                    Text("Saved to Google Calendar as a closed event. If you add an email, Google sends them an invitation.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Google Calendar isn't connected, so this is saved as a Cadence event only (no invitation).")
                        .font(.caption).foregroundStyle(.secondary)
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
                    .disabled(!emailOK || working)
            }
            .padding(16)
        }
        .frame(width: 480)
        .onAppear {
            start = request.start
            minutes = min(30, max(15, Int(request.rangeEnd.timeIntervalSince(request.start) / 60)))
        }
    }

    private func book() async {
        working = true
        defer { working = false }
        let who = name.trimmingCharacters(in: .whitespaces), mail = email.trimmingCharacters(in: .whitespaces)
        let t0 = title.trimmingCharacters(in: .whitespaces)
        let finalTitle = t0.isEmpty ? (who.isEmpty ? "Meeting" : "Meeting with \(who)") : t0
        let begin = dayAt(request.start, minutes: start.minutesSinceMidnight)
        var local = PlanTask(title: finalTitle, notes: notes, startDate: begin.startOfDay, timeMinutes: begin.minutesSinceMidnight,
                             durationMinutes: minutes, reminderOffsets: [10], channels: store.settings.defaultChannels, color: .purple)
        local.kind = "event"
        local.busy = true
        if google.isConnected {
            do {
                let ev = try await google.create(NewGoogleEvent(
                    title: finalTitle, details: notes, start: begin, end: begin.adding(minutes: minutes),
                    attendees: mail.isEmpty ? [] : [(mail, who)], addMeetLink: addMeet, busy: true))
                // Keep the synced copy right away (same ID the importer gives it) so open time updates at once.
                if let ev {
                    let raw = ev.id.split(separator: "|", maxSplits: 1).last.map(String.init) ?? ev.id
                    local.id = stableUUID("google:\(raw)")
                    local.source = "google"; local.googleEventID = raw
                    local.sourceCalendar = ev.calendarID; local.externalURL = ev.link?.absoluteString
                    store.upsert(local)
                }
                done(mail.isEmpty ? "Booked “\(finalTitle)” in Cadence and Google Calendar." : "Booked “\(finalTitle)” — invitation sent to \(mail).")
            } catch {
                self.error = error.localizedDescription
            }
        } else {
            store.upsert(local)
            done("Booked “\(finalTitle)” on your Cadence calendar.")
        }
    }
}
