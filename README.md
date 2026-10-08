# DyslexiLens

### An Assistive Reading Tool for Dyslexia-Friendly Learning

DyslexiLens is a web-based assistive reading application designed to make educational documents more accessible and customizable for learners with dyslexia.
The application accepts PDFs and images, extracts their text using direct PDF extraction or Optical Character Recognition (OCR), and presents the content in a customizable reading interface.
DyslexiLens combines document processing, OCR, reading customization, visual reading aids, and text-to-speech in a single workflow.

> **Note:** DyslexiLens is an accessibility tool. It does not diagnose, treat, or cure dyslexia.

---
## 1. Problem Statement

Educational material is commonly provided in the form of:

- PDFs
- Scanned documents
- Images
- Screenshots
- Printed learning material

These materials may have:

- Fixed typography
- Dense text
- Limited spacing controls
- Small or uncomfortable fonts
- Scanned pages that cannot be directly selected or processed as text

For learners who experience reading difficulties, conventional document viewers may not provide enough control over how the content is presented.
DyslexiLens addresses this problem by extracting the content and presenting it in a customizable reading environment.

---
## 2. Solution

DyslexiLens separates document processing from reading presentation.
The basic workflow is:

```text
Upload Document
       ↓
Identify File Type
       ↓
Text Extraction
       ↓
OCR if Required
       ↓
Extracted Text
       ↓
Customizable Reading Interface
       ↓
Reading Assistance

