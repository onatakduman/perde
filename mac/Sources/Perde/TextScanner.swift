import CoreImage
import Vision

/// A line of text as Vision reports it. `box` is normalised to the image with a bottom-left origin.
struct TextLine {
    let text: String
    let box: CGRect
}

enum TextScanner {
    /// Recognises the text in an image, one entry per line.
    static func recognise(_ image: CIImage) -> [TextLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate // The fast path misreads small UI text and knows fewer scripts.
        request.recognitionLanguages = recognitionLanguages
        // Correction pulls unusual words towards dictionary words, and names are unusual words.
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(ciImage: image).perform([request])

        return (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first.map { TextLine(text: $0.string, box: observation.boundingBox) }
        }
    }

    /// The lines to cover: every line that mentions a blocked name, plus both halves of a name
    /// that wraps from the end of one line to the start of the next.
    static func matchedLines(_ lines: [TextLine], matcher: NameMatcher) -> [TextLine] {
        var hit = lines.map { matcher.matches($0.text) }
        for (index, line) in lines.enumerated() {
            guard let below = indexOfLine(below: line, in: lines), !(hit[index] && hit[below]) else { continue }
            if matcher.matchesAcross(line.text, lines[below].text) {
                hit[index] = true
                hit[below] = true
            }
        }
        return zip(lines, hit).filter(\.1).map(\.0)
    }

    /// The nearest line directly under `line` in the same column, if it is close enough to be the same paragraph.
    private static func indexOfLine(below line: TextLine, in lines: [TextLine]) -> Int? {
        var best: (index: Int, gap: CGFloat)?
        for (index, other) in lines.enumerated() {
            let gap = line.box.minY - other.box.maxY
            let sharesColumn = other.box.minX < line.box.maxX && other.box.maxX > line.box.minX
            // Up to one and a half line heights apart: enough for double-spaced text, too little to jump a paragraph break.
            guard sharesColumn, other.box.midY < line.box.minY, gap < line.box.height * 1.5 else { continue }
            if best == nil || gap < best!.gap { best = (index, gap) }
        }
        return best?.index
    }

    /// The user's languages first, then every other language Vision knows, so names in any
    /// supported script are read. Accents need no special care: the matcher folds them away.
    private static let recognitionLanguages: [String] = {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let supported = (try? request.supportedRecognitionLanguages()) ?? ["en-US"]
        let preferred = Locale.preferredLanguages.compactMap { tag -> String? in
            let language = tag.split(separator: "-").first.map(String.init) ?? tag
            return supported.first { $0 == tag } ?? supported.first { $0.hasPrefix(language + "-") }
        }
        return preferred + supported.filter { !preferred.contains($0) }
    }()
}
