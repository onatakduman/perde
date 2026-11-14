import Foundation

/// One blocked person, as exported by the extension.
struct BlockEntry: Decodable {
    let name: String
    let aliases: [String]
    let enabled: Bool
    let faces: [[Float]]

    static let descriptorLength = 128

    private enum CodingKeys: String, CodingKey { case name, aliases, enabled, faces }

    init(name: String, aliases: [String] = [], enabled: Bool = true, faces: [[Float]] = []) {
        self.name = name
        self.aliases = aliases
        self.enabled = enabled
        self.faces = faces
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        aliases = (try? container.decode([String].self, forKey: .aliases)) ?? []
        // The extension treats everything except an explicit `false` as enabled.
        enabled = (try? container.decode(Bool.self, forKey: .enabled)) ?? true
        let rawFaces = (try? container.decode([[Float]].self, forKey: .faces)) ?? []
        faces = rawFaces.filter { $0.count == Self.descriptorLength }
    }
}

/// The parsed block list: what to look for in text and which faces to compare against.
struct BlockList {
    /// Same file name the extension's "Export to file" button produces, so the file only has to be moved here.
    static let fileURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Perde/perde-blocklist.json")
    static let defaultFaceThreshold: Float = 0.55

    let entries: [BlockEntry] // Enabled entries only.
    let faceThreshold: Float
    let matcher: NameMatcher?

    var faceCount: Int { entries.reduce(0) { $0 + $1.faces.count } }
    var isEmpty: Bool { matcher == nil && faceCount == 0 }

    init(entries: [BlockEntry], faceThreshold: Float = BlockList.defaultFaceThreshold) {
        self.entries = entries.filter(\.enabled)
        self.faceThreshold = faceThreshold
        self.matcher = NameMatcher(entries: self.entries)
    }

    enum LoadResult {
        case missing
        case invalid(String)
        case loaded(BlockList)
    }

    static func load(from url: URL = fileURL) -> LoadResult {
        guard let data = try? Data(contentsOf: url) else { return .missing }
        do {
            let file = try JSONDecoder().decode(File.self, from: data)
            guard file.format == "perde-blocklist" else { return .invalid("not a Perde block list") }
            var threshold = file.faceThreshold ?? defaultFaceThreshold
            if !(threshold.isFinite && threshold > 0) { threshold = defaultFaceThreshold }
            return .loaded(BlockList(entries: (file.entries ?? []).compactMap(\.value), faceThreshold: threshold))
        } catch {
            return .invalid("not valid JSON")
        }
    }

    /// The closest reference face over all entries, by Euclidean distance (what face-api.js uses).
    func nearestFace(to descriptor: [Float]) -> (name: String, distance: Float)? {
        var best: (name: String, distance: Float)?
        for entry in entries {
            for face in entry.faces {
                var sum: Float = 0
                for (a, b) in zip(face, descriptor) { sum += (a - b) * (a - b) }
                let distance = sum.squareRoot()
                if best == nil || distance < best!.distance { best = (entry.name, distance) }
            }
        }
        return best
    }

    private struct File: Decodable {
        let format: String?
        let faceThreshold: Float?
        let entries: [Lossy<BlockEntry>]?
    }

    /// One malformed entry must not throw away the rest of the list.
    private struct Lossy<Value: Decodable>: Decodable {
        let value: Value?
        init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
    }
}

/// Swift port of `fold` and `buildMatcher` in perde/shared/common.js. The two must agree,
/// otherwise a name blurred in the browser would stay readable everywhere else (or the reverse).
struct NameMatcher {
    let minLength: Int
    private let pattern: NSRegularExpression

    init?(entries: [BlockEntry]) {
        var terms = Set<String>()
        for entry in entries where entry.enabled {
            for raw in [entry.name] + entry.aliases {
                let term = Self.fold(Self.cleanTerm(raw))
                if term.utf16.count >= 2 { terms.insert(term) }
            }
        }
        guard !terms.isEmpty else { return nil }

        let sorted = terms.sorted { $0.utf16.count != $1.utf16.count ? $0.utf16.count > $1.utf16.count : $0 < $1 }
        let body = sorted.map(Self.termPattern).joined(separator: "|")
        guard let pattern = try? NSRegularExpression(pattern: "(?<![\\p{L}\\p{N}])(?:\(body))(?![\\p{L}\\p{N}])") else { return nil }
        self.pattern = pattern
        self.minLength = sorted.map(\.utf16.count).min() ?? 2
    }

    /// A space or hyphen inside a term stands for any run of whitespace and hyphens, so
    /// "Jean-Luc Godard" also finds "Jean Luc Godard" and a name broken across two lines.
    private static func termPattern(_ term: String) -> String {
        // ICU's \s is narrower than JavaScript's; the class adds what is missing.
        let separator = "[\\s\\x0B\\x{FEFF}-]+"
        var pattern = ""
        var literal = ""
        for character in term {
            if character == " " || character == "-" {
                if !literal.isEmpty || pattern.isEmpty { // First separator of a run.
                    pattern += NSRegularExpression.escapedPattern(for: literal) + separator
                    literal = ""
                }
            } else {
                literal.append(character)
            }
        }
        return pattern + NSRegularExpression.escapedPattern(for: literal)
    }

    func matches(_ text: String) -> Bool {
        guard text.utf16.count >= minLength else { return false }
        let folded = Self.fold(text)
        return pattern.firstMatch(in: folded, range: NSRange(folded.startIndex..., in: folded)) != nil
    }

    /// True when a term starts at the end of `first` and finishes at the start of `second`:
    /// a name that wraps across two lines of text.
    func matchesAcross(_ first: String, _ second: String) -> Bool {
        let head = Self.fold(first)
        let joined = head + " " + Self.fold(second)
        let boundary = head.utf16.count
        return pattern.matches(in: joined, range: NSRange(joined.startIndex..., in: joined)).contains {
            $0.range.location < boundary && $0.range.upperBound > boundary + 1
        }
    }

    /// Case and accent insensitive form: "NURİ BİLGE" and "nuri bilge" fold to the same text.
    static func fold(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.decomposedStringWithCompatibilityMapping.unicodeScalars {
            switch scalar.value {
            case 0x0300...0x036F: continue // Combining marks left behind by the decomposition.
            case 0x0131: scalars.append("i") // Dotless ı has no decomposition.
            default: scalars.append(scalar)
            }
        }
        // Foundation's lowercasing, not the standard library's: like JavaScript it turns a final Σ
        // into ς. The nil locale keeps the user's language out of it (in Turkish, "I" would become "ı").
        return String(scalars).lowercased(with: nil)
    }

    static func cleanTerm(_ value: String) -> String {
        let collapsed = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(collapsed.prefix(80))
    }
}
