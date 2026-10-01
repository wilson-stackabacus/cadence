import Foundation
import Network
import Security
import CryptoKit

struct GoogleTokens: Codable {
    var accessToken: String
    var refreshToken: String
    var expiry: Date
}

enum GoogleError: LocalizedError {
    case missingClient, notConnected, cancelled, timedOut, stateMismatch
    case oauth(String)
    case http(Int, String)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .missingClient: return "Add your Google OAuth Client ID and secret in Settings first."
        case .notConnected: return "Google Calendar is not connected."
        case .cancelled: return "Sign-in was cancelled."
        case .timedOut: return "Sign-in timed out. Try again."
        case .stateMismatch: return "Sign-in response didn't match the request. Try again."
        case .oauth(let e): return "Google sign-in failed: \(e)"
        case .http(let code, let msg): return "Google returned \(code): \(msg)"
        case .badResponse: return "Unexpected response from Google."
        }
    }
}

// MARK: - Keychain

enum Keychain {
    private static let service = "com.ryanpark.cadence.google"
    private static let account = "oauth-tokens"

    static func save(_ tokens: GoogleTokens) {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load() -> GoogleTokens? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(GoogleTokens.self, from: data)
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
    // MARK: Plain strings (the sync login token)

    private static let stringService = "com.ryanpark.cadence.sync"

    static func setString(_ value: String?, account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stringService,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard let value else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    static func string(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stringService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - PKCE

enum PKCE {
    static func verifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64url(Data(bytes))
    }

    static func challenge(for verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - Loopback redirect server

/// A one-shot HTTP server on 127.0.0.1 that receives Google's OAuth redirect.
/// This is Google's recommended flow for desktop apps.
final class LoopbackServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "cadence.oauth.loopback")
    private var result: Result<[String: String], Error>?
    private var waiter: CheckedContinuation<[String: String], Error>?
    private var startResumed = false   // only touched on `queue`

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: params)
    }

    /// Starts listening and returns the port the OS assigned.
    func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            listener.stateUpdateHandler = { [unowned self] state in
                guard !self.startResumed else { return }
                switch state {
                case .ready:
                    self.startResumed = true
                    cont.resume(returning: self.listener.port?.rawValue ?? 0)
                case .failed(let error):
                    self.startResumed = true
                    cont.resume(throwing: error)
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [unowned self] conn in self.handle(conn) }
            listener.start(queue: queue)
        }
    }

    func waitForCallback(timeout: TimeInterval = 300) async throws -> [String: String] {
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish(.failure(GoogleError.timedOut)) }
        return try await withCheckedThrowingContinuation { cont in
            queue.async {
                if let r = self.result { self.result = nil; cont.resume(with: r) } else { self.waiter = cont }
            }
        }
    }

    func stop() {
        queue.async {
            self.listener.cancel()
            self.finishLocked(.failure(GoogleError.cancelled))
        }
    }

    private func finish(_ r: Result<[String: String], Error>) { queue.async { self.finishLocked(r) } }

    private func finishLocked(_ r: Result<[String: String], Error>) {
        if let w = waiter { waiter = nil; w.resume(with: r) } else if result == nil { result = r }
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let text = String(data: data, encoding: .utf8),
                  let line = text.components(separatedBy: "\r\n").first else { conn.cancel(); return }
            let parts = line.split(separator: " ")
            guard parts.count >= 2, let comps = URLComponents(string: "http://127.0.0.1" + parts[1]) else {
                conn.cancel(); return
            }
            var params: [String: String] = [:]
            for item in comps.queryItems ?? [] { params[item.name] = item.value ?? "" }
            guard params["code"] != nil || params["error"] != nil else {
                self.respond(conn, status: "404 Not Found", html: "")
                return
            }
            let ok = params["code"] != nil
            self.respond(conn, status: "200 OK", html: Self.page(ok: ok))
            self.finishLocked(.success(params))
        }
    }

    private func respond(_ conn: NWConnection, status: String, html: String) {
        let body = Data(html.utf8)
        var resp = Data("HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
        resp.append(body)
        conn.send(content: resp, completion: .contentProcessed { _ in conn.cancel() })
    }

    private static func page(ok: Bool) -> String {
        let msg = ok ? "Cadence is connected to Google Calendar. You can close this tab."
                     : "Sign-in didn't complete. Return to Cadence and try again."
        return """
        <!doctype html><html><head><meta charset="utf-8"><title>Cadence</title>
        <style>body{font:16px -apple-system,system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}
        div{background:#fff;padding:32px 40px;border-radius:16px;box-shadow:0 4px 24px #0001;max-width:420px;text-align:center}
        @media(prefers-color-scheme:dark){body{background:#1d1d1f;color:#f5f5f7}div{background:#2c2c2e}}</style></head>
        <body><div><h2>Cadence</h2><p>\(msg)</p></div></body></html>
        """
    }
}
