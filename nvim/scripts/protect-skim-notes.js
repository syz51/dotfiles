function run(argv) {
  ObjC.import("Foundation");
  ObjC.import("PDFKit");
  var pdfPath = argv[0];
  if (!/\.pdf$/i.test(pdfPath)) throw new Error("Expected a PDF output path.");
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(pdfPath)) return;

  var pdf = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(pdfPath));
  if (!pdf) throw new Error("The existing PDF cannot be read; preserve or repair it before rebuilding.");
  for (var page = 0; page < pdf.pageCount; page++) {
    var annotations = pdf.pageAtIndex(page).annotations;
    for (var i = 0; i < annotations.count; i++) {
      if (ObjC.unwrap(annotations.objectAtIndex(i).type) !== "Link") {
        throw new Error("The PDF has embedded annotations. Convert them to Skim notes and save before rebuilding.");
      }
    }
  }

  var skim = Application("Skim");
  if (!skim.running()) return;
  var documents = skim.documents.whose({ file: { _equals: Path(pdfPath) } });
  if (documents.length === 0) return;
  var document = documents[0];
  var modified = document.modified();
  var backup = pdfPath.replace(/\.pdf$/i, ".skim");
  if (modified || document.notes.length > 0) {
    skim.save(document, { in: Path(backup), as: "Skim Notes" });
  }
  if (modified) {
    // Reload the new PDF before restoring notes added during compilation.
    if (argv[1] === "refresh") {
      skim.revert(document);
      skim.readNotes(document, { from: Path(backup), replacing: true });
    }
    skim.save(document);
  }
}
