import XCTest
@testable import Perde

/// The text cases mirror tests/fixture.html, which the extension's end-to-end test runs against
/// the JavaScript matcher: blocked name "Deniz Karaca", alias "Karaca".
final class MatcherTests: XCTestCase {
    private let matcher = NameMatcher(entries: [BlockEntry(name: "Deniz Karaca", aliases: ["Karaca"])])!

    func testFixtureLinesThatMustMatch() {
        for text in [
            "Deniz Karaca yeni filmini duyurdu", // #card-2
            "Eleştirmenler DENİZ KARACA'nın son filmini tartışıyor.", // #p-upper: Turkish upper case plus suffix
            "Yönetmen Karaca ise sessizliğini koruyor.", // #p-alias
            "Deniz Karaca kırmızı halıda", // #img-alt
            "Deniz Karaca hakkında notlar", // #area
            "Bileşen içinde Deniz Karaca haberi.", // #shadow-hit
            "Sonradan gelen: Deniz Karaca röportajı", // #card-late
        ] {
            XCTAssertTrue(matcher.matches(text), text)
        }
    }

    func testFixtureLinesThatMustNotMatch() {
        for text in [
            "Festival programı açıklandı", // #card-1
            "Bu paragrafta kimseden söz edilmiyor.", // #p-clean
            "Karacaoğlan şiirleri üzerine bir not: bu paragraf eşleşmemeli.", // #p-boundary: word boundary
            "Gişe rakamları", // #card-3
            "Boş koltuklar", // #img-clean
            "Bileşen içi temiz satır.", // #shadow-clean
        ] {
            XCTAssertFalse(matcher.matches(text), text)
        }
    }

    func testFoldMatchesTheExtension() {
        XCTAssertEqual(NameMatcher.fold("NURİ BİLGE"), "nuri bilge")
        XCTAssertEqual(NameMatcher.fold("IŞIK ışık"), "isik isik") // Dotless ı and cedilla
        XCTAssertEqual(NameMatcher.fold("Éric Çağrı Öztürk"), "eric cagri ozturk")
        XCTAssertEqual(NameMatcher.fold("ﬁlm ①"), "film 1") // Compatibility forms
        XCTAssertEqual(NameMatcher.fold("plain ASCII"), "plain ascii")
        XCTAssertEqual(NameMatcher.fold("ΟΔΟΣ"), "οδος") // Final sigma, as String.prototype.toLowerCase does
    }

    func testWordBoundaries() {
        XCTAssertFalse(matcher.matches("Akkaraca köyü"))
        XCTAssertFalse(matcher.matches("Karaca2 sürümü"))
        XCTAssertFalse(matcher.matches("7Karaca"))
        XCTAssertTrue(matcher.matches("(Karaca)"))
        XCTAssertTrue(matcher.matches("karaca."))
        XCTAssertTrue(matcher.matches("@karaca_")) // "_" is neither a letter nor a digit, as in the extension
    }

    func testSpacesAndHyphensInsideATerm() {
        let godard = NameMatcher(entries: [BlockEntry(name: "Jean-Luc Godard")])!
        XCTAssertTrue(godard.matches("jean luc godard"))
        XCTAssertTrue(godard.matches("Jean-Luc   Godard"))
        XCTAssertTrue(godard.matches("JEAN - LUC\nGODARD"))
        XCTAssertTrue(godard.matches("Jean\u{00A0}Luc-Godard"))
        XCTAssertFalse(godard.matches("JeanLuc Godard"))
        XCTAssertFalse(godard.matches("Jean Luc"))
    }

    func testShortTermsDisabledEntriesAndSpecialCharacters() {
        XCTAssertNil(NameMatcher(entries: [BlockEntry(name: "A", aliases: ["", " "])]))
        XCTAssertNil(NameMatcher(entries: [BlockEntry(name: "Deniz Karaca", enabled: false)]))

        let mixed = NameMatcher(entries: [BlockEntry(name: "X", aliases: ["C++ (dil)", "  Ali   Veli  "]), BlockEntry(name: "Gizli", enabled: false)])!
        XCTAssertEqual(mixed.minLength, 8)
        XCTAssertTrue(mixed.matches("Bugün C++ (dil) konuştuk"))
        XCTAssertTrue(mixed.matches("ali veli geldi"))
        XCTAssertFalse(mixed.matches("X geldi"))
        XCTAssertFalse(mixed.matches("Gizli kişi"))
    }

    func testNameWrappedAcrossTwoLines() {
        XCTAssertTrue(matcher.matchesAcross("Bu yazının konusu yönetmen Deniz", "Karaca ve yeni filmi olacak."))
        XCTAssertFalse(matcher.matchesAcross("Yönetmen Karaca ise", "sessizliğini koruyor.")) // Inside one line is not "across"
        XCTAssertFalse(matcher.matchesAcross("Bu yazının konusu deniz", "kenarında geçiyor."))

        let lines = [
            TextLine(text: "Bu yazının konusu yönetmen Deniz", box: CGRect(x: 0.1, y: 0.50, width: 0.5, height: 0.04)),
            TextLine(text: "Karaca ve yeni filmi olacak.", box: CGRect(x: 0.1, y: 0.45, width: 0.4, height: 0.04)),
            TextLine(text: "Başka bir sütun: Deniz", box: CGRect(x: 0.7, y: 0.50, width: 0.2, height: 0.04)),
            TextLine(text: "Gişe rakamları", box: CGRect(x: 0.1, y: 0.20, width: 0.3, height: 0.04)),
        ]
        XCTAssertEqual(TextScanner.matchedLines(lines, matcher: matcher).map(\.text), [lines[0].text, lines[1].text])
    }
}

final class BlockListTests: XCTestCase {
    func testLoadingToleratesUnknownKeysMissingFacesAndBadEntries() throws {
        let face = Array(repeating: "0.1", count: 128).joined(separator: ",")
        let json = """
        { "format": "perde-blocklist", "version": 1, "faceThreshold": 0.5, "somethingNew": [1, 2],
          "entries": [
            { "id": "a", "name": "Deniz Karaca", "aliases": ["Karaca"], "enabled": true, "faces": [[\(face)], [1, 2, 3]], "extra": {} },
            { "id": "b", "name": "No Faces" },
            { "id": "c", "name": "Disabled", "enabled": false, "faces": [[\(face)]] },
            { "id": "d" },
            "not an entry"
          ] }
        """
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("perde-test-\(UUID().uuidString).json")
        try Data(json.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        guard case .loaded(let list) = BlockList.load(from: url) else { return XCTFail("block list did not load") }
        XCTAssertEqual(list.entries.map(\.name), ["Deniz Karaca", "No Faces"])
        XCTAssertEqual(list.faceCount, 1) // The three-number face is dropped, the disabled entry's is not counted.
        XCTAssertEqual(list.faceThreshold, 0.5)
        XCTAssertTrue(list.matcher!.matches("no faces here"))
        XCTAssertFalse(list.matcher!.matches("Disabled"))

        var probe = [Float](repeating: 0.1, count: 128)
        probe[0] = 0.4
        let nearest = try XCTUnwrap(list.nearestFace(to: probe))
        XCTAssertEqual(nearest.name, "Deniz Karaca")
        XCTAssertEqual(nearest.distance, 0.3, accuracy: 0.0001)
    }

    func testMissingAndInvalidFiles() throws {
        let missing = URL(fileURLWithPath: "/nonexistent/blocklist.json")
        guard case .missing = BlockList.load(from: missing) else { return XCTFail("expected .missing") }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("perde-test-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(#"{"format": "something-else", "entries": []}"#.utf8).write(to: url)
        guard case .invalid = BlockList.load(from: url) else { return XCTFail("expected .invalid for a foreign format") }
        try Data("not json".utf8).write(to: url)
        guard case .invalid = BlockList.load(from: url) else { return XCTFail("expected .invalid for broken JSON") }
    }
}

final class OverlayGeometryTests: XCTestCase {
    func testVisionBoxMapsToViewPointsWhateverTheCaptureScale() {
        // A 1728x1117 pt display. Vision reports fractions of the frame, so a 1x and a 2x capture
        // of the same screen give the same box, and the same patch.
        let display = CGSize(width: 1728, height: 1117)
        let box = CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.02) // Bottom-left origin, like AppKit
        let rect = OverlayGeometry.viewRect(for: box, kind: .text, in: display)
        let padding = max(4, 1117 * 0.02 * 0.25)
        XCTAssertEqual(rect.minX, 432 - padding, accuracy: 0.001)
        XCTAssertEqual(rect.minY, 558.5 - padding, accuracy: 0.001)
        XCTAssertEqual(rect.width, 864 + 2 * padding, accuracy: 0.001)
        XCTAssertEqual(rect.height, 22.34 + 2 * padding, accuracy: 0.001)
    }

    func testPatchesStayInsideTheDisplay() {
        let display = CGSize(width: 1000, height: 500)
        let face = CGRect(x: 0.9, y: 0.8, width: 0.1, height: 0.2)
        let rect = OverlayGeometry.viewRect(for: face, kind: .face, in: display)
        XCTAssertEqual(rect.maxX, 1000)
        XCTAssertEqual(rect.maxY, 500)
        XCTAssertEqual(rect.minX, 900 - 30, accuracy: 0.001) // 30% of the larger side (100 pt)
    }
}
