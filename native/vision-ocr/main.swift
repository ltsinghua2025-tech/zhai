import AppKit
import Foundation
import PDFKit
import Vision

struct OCRLine: Codable {
    let text: String
    let confidence: Float
}

struct OCRPage: Codable {
    let page: Int
    let averageConfidence: Float
    let lines: [OCRLine]
}

struct OCRResult: Codable {
    let source: String
    let languages: [String]
    let pages: [OCRPage]
}

enum OCRError: Error, CustomStringConvertible {
    case invalidArguments
    case unsupportedFile
    case cannotRender(Int)

    var description: String {
        switch self {
        case .invalidArguments:
            return "用法：material-workshop-vision-ocr --input <绝对路径> [--languages zh-Hans,en-US]"
        case .unsupportedFile:
            return "只支持 PDF 或 macOS 可读取的图像格式"
        case .cannotRender(let page):
            return "无法渲染第 \(page) 页"
        }
    }
}

func argumentValue(_ flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag), index + 1 < CommandLine.arguments.count else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

func cgImage(from image: NSImage) -> CGImage? {
    var proposedRect = CGRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
}

func render(page: PDFPage, index: Int) throws -> CGImage {
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2.0
    let width = max(Int(bounds.width * scale), 1)
    let height = max(Int(bounds.height * scale), 1)
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw OCRError.cannotRender(index + 1)
    }
    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    guard let image = context.makeImage() else {
        throw OCRError.cannotRender(index + 1)
    }
    return image
}

func recognize(_ image: CGImage, pageNumber: Int, languages: [String]) throws -> OCRPage {
    var observations: [VNRecognizedTextObservation] = []
    var requestError: Error?
    let request = VNRecognizeTextRequest { request, error in
        requestError = error
        observations = request.results as? [VNRecognizedTextObservation] ?? []
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    if let requestError {
        throw requestError
    }
    let lines = observations.compactMap { observation -> OCRLine? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return OCRLine(text: candidate.string, confidence: candidate.confidence)
    }
    let average = lines.isEmpty ? 0 : lines.reduce(0) { $0 + $1.confidence } / Float(lines.count)
    return OCRPage(page: pageNumber, averageConfidence: average, lines: lines)
}

func run() throws -> OCRResult {
    guard let inputValue = argumentValue("--input") else { throw OCRError.invalidArguments }
    let input = URL(fileURLWithPath: inputValue)
    guard input.path.hasPrefix("/") else { throw OCRError.invalidArguments }
    let languages = (argumentValue("--languages") ?? "zh-Hans,en-US")
        .split(separator: ",")
        .map(String.init)
    var pages: [OCRPage] = []

    if input.pathExtension.lowercased() == "pdf" {
        guard let document = PDFDocument(url: input) else { throw OCRError.unsupportedFile }
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            let image = try render(page: page, index: index)
            pages.append(try recognize(image, pageNumber: index + 1, languages: languages))
        }
    } else {
        guard let image = NSImage(contentsOf: input), let rendered = cgImage(from: image) else {
            throw OCRError.unsupportedFile
        }
        pages.append(try recognize(rendered, pageNumber: 1, languages: languages))
    }
    return OCRResult(source: input.path, languages: languages, pages: pages)
}

do {
    let result = try run()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    FileHandle.standardOutput.write(try encoder.encode(result))
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    FileHandle.standardError.write(Data("Vision OCR 失败：\(error)\n".utf8))
    exit(1)
}
