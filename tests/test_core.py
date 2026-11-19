import base64
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import smart_ppt


class SmartPPTCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def build(self, source, name="result.pptx"):
        blocks, decorations, notes = smart_ppt.parse_document(source)
        model = smart_ppt.make_model(source, blocks, decorations, notes)
        pages = smart_ppt.plan_pages(model)
        job = {"source": str(source), "content_file": "content.json", "page_count": len(pages), "pages": pages}
        smart_ppt.write_json(self.work / "content.json", model)
        smart_ppt.write_json(self.work / "job.json", job)
        output = self.work / name
        fade_count = smart_ppt.render_package(job, ROOT / "src" / "assets" / "base.pptx", output)
        return model, job, output, fade_count

    def assert_valid_deck(self, model, job, output):
        with zipfile.ZipFile(output) as archive:
            self.assertIsNone(archive.testzip())
            slide_names = [name for name in archive.namelist() if smart_ppt.re.match(r"ppt/slides/slide\d+\.xml$", name)]
            self.assertEqual(len(slide_names), len(job["pages"]))
            all_text = []
            for page in job["pages"]:
                root = ET.fromstring(archive.read(f"ppt/slides/slide{page['number']}.xml"))
                all_text.extend(node.text or "" for node in root.findall(".//a:t", smart_ppt.NS))
                self.assertEqual(len(smart_ppt.drawable_elements(root)), len(page["page"]["elements"]))
                self.assertEqual(len(root.findall(".//p159:morph", smart_ppt.NS)), int(page["number"] > 1))
                self.assertFalse(root.findall(".//p14:morph", smart_ppt.NS))
                self.assertTrue(all(node.get("thruBlk") == "0" for node in root.findall(".//p:fade", smart_ppt.NS)))
            joined = smart_ppt.clean(" ".join(all_text))
            for item in model["blocks"]:
                self.assertIn(smart_ppt.clean(item["text"]), joined)

    def test_markdown_end_to_end(self):
        model, job, output, fade_count = self.build(ROOT / "examples" / "outline.md")
        self.assertEqual(len(model["blocks"]), 18)
        self.assertEqual(len(job["pages"]), 6)
        self.assertGreater(fade_count, 0)
        self.assert_valid_deck(model, job, output)

    def test_pptx_round_trip_preserves_recognized_text(self):
        first = self.work / "first.pptx"
        model, job, _, _ = self.build(ROOT / "examples" / "outline.md", "first.pptx")
        self.assertTrue(first.exists())
        second_source = self.work / "first.pptx"
        second_model, second_job, second_output, _ = self.build(second_source, "second.pptx")
        self.assertGreaterEqual(len(second_model["blocks"]), len(model["blocks"]))
        self.assertTrue(all(not smart_ppt.re.fullmatch(r"\d{1,2}", item["text"])
                            for item in second_model["blocks"] if item["kind"] == "heading"))
        self.assert_valid_deck(second_model, second_job, second_output)

    def test_txt_and_docx_parsing(self):
        txt = self.work / "outline.txt"
        txt.write_text("第一章 项目目标\n- 保留 100% 原文\n普通说明\n备注：这里只讲，不放进页面", encoding="utf-8")
        blocks, _, notes = smart_ppt.parse_document(txt)
        self.assertEqual([item["kind"] for item in blocks], ["heading", "bullet", "paragraph"])
        self.assertEqual(blocks[1]["numbers"], ["100%"])
        self.assertEqual([item["text"] for item in notes], ["这里只讲，不放进页面"])

        document = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目标题</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
        <w:p><w:r><w:t>正文说明</w:t></w:r></w:p></w:body></w:document>'''
        styles = '''<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'''
        docx = self.work / "outline.docx"
        with zipfile.ZipFile(docx, "w") as archive:
            archive.writestr("word/document.xml", document)
            archive.writestr("word/styles.xml", styles)
        blocks, _, _ = smart_ppt.parse_document(docx)
        self.assertEqual([item["kind"] for item in blocks], ["heading", "bullet", "paragraph"])
        self.assertEqual(blocks[0]["level"], 1)

    def test_page_elements_stay_inside_canvas(self):
        _, job, _, _ = self.build(ROOT / "examples" / "outline.md")
        for page in job["pages"]:
            for element in page["page"]["elements"]:
                self.assertGreaterEqual(element["x"], 0)
                self.assertGreaterEqual(element["y"], 0)
                self.assertLessEqual(element["x"] + element["w"], 1280)
                self.assertLessEqual(element["y"] + element["h"], 720)

    def test_images_and_formula_text_are_embedded(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        (self.work / "pixel.png").write_bytes(png)
        source = self.work / "assets.md"
        source.write_text("# 素材示例\n\n## 图片\n![像素示意图](pixel.png)\n\n## 公式\n$$E=mc^2$$\n", encoding="utf-8")
        model, job, output, _ = self.build(source)
        self.assertEqual([item["kind"] for item in model["blocks"]], ["heading", "heading", "image", "heading", "formula"])
        self.assertIn("image", [page["plan"]["layout"] for page in job["pages"]])
        self.assertIn("formula", [page["plan"]["layout"] for page in job["pages"]])
        self.assert_valid_deck(model, job, output)
        with zipfile.ZipFile(output) as archive:
            media = [name for name in archive.namelist() if name.startswith("ppt/media/")]
            self.assertEqual(len(media), 1)
            self.assertEqual(archive.read(media[0]), png)
            picture_slide = next(page["number"] for page in job["pages"] if page["plan"]["layout"] == "image")
            root = ET.fromstring(archive.read(f"ppt/slides/slide{picture_slide}.xml"))
            self.assertEqual(len(root.findall(".//p:pic", smart_ppt.NS)), 1)
            rels = archive.read(f"ppt/slides/_rels/slide{picture_slide}.xml.rels").decode("utf-8")
            self.assertIn("relationships/image", rels)

    def test_long_text_is_fitted_and_native_autofit_is_enabled(self):
        value = "这是一段需要自动缩小的长文本，包含中英文 mixed content。" * 5
        element = smart_ppt.text(100, 100, 400, 120, value, 24)
        size = element["paragraphs"][0]["runs"][0]["sizePt"]
        self.assertLess(size, 24)
        self.assertLessEqual(smart_ppt.estimated_lines(value, 400, size) * size * 96 / 72 * 1.1, 120)
        xml = smart_ppt.text_xml(element, 2, "test")
        self.assertIn("<a:normAutofit/>", xml)

    def test_markdown_notes_stay_out_of_slides(self):
        source = self.work / "notes.md"
        source.write_text("# 标题\n\n正文\n\n> 备注：只用于讲解\n<!-- 另一条备注 -->\n\n::: notes\n补充讲稿\n:::\n", encoding="utf-8")
        model, job, output, _ = self.build(source)
        self.assertEqual(len(model["notes"]), 3)
        self.assertEqual([item["text"] for item in model["blocks"]], ["标题", "正文"])
        with zipfile.ZipFile(output) as archive:
            text = "".join(node.text or "" for name in archive.namelist() if name.startswith("ppt/slides/slide") and name.endswith(".xml")
                           for node in ET.fromstring(archive.read(name)).findall(".//a:t", smart_ppt.NS))
        self.assertNotIn("只用于讲解", text)
        self.assertNotIn("补充讲稿", text)

    def test_mixed_outline_hierarchy_and_numbered_lists(self):
        markdown = self.work / "hierarchy.md"
        markdown.write_text(
            "产品汇报\n===\n\n开篇第一行\n续行\n\n## 第一章\n### 小节\n- 父项\n  - 子项\n",
            encoding="utf-8",
        )
        blocks, _, _ = smart_ppt.parse_document(markdown)
        self.assertEqual([item["kind"] for item in blocks],
                         ["heading", "paragraph", "heading", "heading", "bullet", "bullet"])
        self.assertEqual(blocks[1]["text"], "开篇第一行续行")
        self.assertEqual(blocks[-1]["level"], 2)
        model = smart_ppt.make_model(markdown, blocks)
        self.assertEqual([section["title"] for section in model["sections"]], ["第一章"])
        self.assertEqual([item["text"] for item in model["sections"][0]["items"]], ["小节", "父项", "子项"])

        text = self.work / "numbered.txt"
        text.write_text("产品汇报\n\n一、现状\n1. 第一个要点\n2. 第二个要点\n二、计划\n普通说明", encoding="utf-8")
        blocks, _, _ = smart_ppt.parse_document(text)
        self.assertEqual([item["kind"] for item in blocks],
                         ["heading", "heading", "bullet", "bullet", "heading", "paragraph"])
        model = smart_ppt.make_model(text, blocks)
        self.assertEqual([section["title"] for section in model["sections"]], ["一、现状", "二、计划"])
        self.assertEqual(len(model["sections"][0]["items"]), 2)

        numeric = self.work / "numeric-sections.txt"
        numeric.write_text("产品汇报\n1. 背景\n背景说明\n2. 目标\n目标说明", encoding="utf-8")
        blocks, _, _ = smart_ppt.parse_document(numeric)
        self.assertEqual([item["kind"] for item in blocks],
                         ["heading", "heading", "paragraph", "heading", "paragraph"])

    def test_docx_title_outline_nested_list_and_table(self):
        document = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>项目标题</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>项目副标题</w:t></w:r></w:p>
        <w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>自动大纲章节</w:t></w:r></w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>二级列表</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>'''
        styles = '''<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:styleId="Title"><w:name w:val="Title"/></w:style>
        <w:style w:styleId="Subtitle"><w:name w:val="Subtitle"/></w:style></w:styles>'''
        source = self.work / "mixed.docx"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("word/document.xml", document)
            archive.writestr("word/styles.xml", styles)
        blocks, _, _ = smart_ppt.parse_document(source)
        self.assertEqual([item["kind"] for item in blocks],
                         ["heading", "subtitle", "heading", "bullet", "paragraph"])
        self.assertEqual(blocks[2]["level"], 2)
        self.assertEqual(blocks[3]["level"], 2)
        self.assertEqual(blocks[-1]["text"], "表格文字")

    def test_messy_pptx_order_tables_smartart_and_notes(self):
        def text_shape(name, value, size, top, placeholder=""):
            ph = f'<p:ph type="{placeholder}"/>' if placeholder else ""
            return f'''<p:sp><p:nvSpPr><p:cNvPr id="2" name="{name}"/><p:cNvSpPr/><p:nvPr>{ph}</p:nvPr></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="500000" y="{top * 9525}"/></a:xfrm></p:spPr><p:txBody><a:p>
            <a:pPr><a:defRPr sz="{size * 100}"/></a:pPr><a:r><a:t>{value}</a:t></a:r></a:p></p:txBody></p:sp>'''

        def slide(body):
            return f'''<p:sld xmlns:a="{smart_ppt.A}" xmlns:p="{smart_ppt.P}" xmlns:r="{smart_ppt.R}"
            xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><p:cSld><p:spTree>
            <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
            {body}</p:spTree></p:cSld></p:sld>'''

        table = '''<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="500000" y="4286250"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>表格内容</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>
        </a:graphicData></a:graphic></p:graphicFrame>'''
        smartart = '''<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="流程图"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rId2"/></a:graphicData></a:graphic></p:graphicFrame>'''
        first_slide = slide(text_shape("标题", "封面标题", 30, 100, "title")
                            + text_shape("副标题", "封面副标题", 18, 250, "subTitle")
                            + text_shape("品牌", "INTELLIGENT PPT / 01", 11, 40)
                            + text_shape("英文来源", "SOURCE: ACME", 10, 620)
                            + text_shape("大数字", "99%", 48, 400) + table + smartart)
        second_slide = slide(text_shape("章节", "第二章", 28, 100) + text_shape("正文", "第二页正文", 16, 300))
        presentation = f'''<p:presentation xmlns:p="{smart_ppt.P}" xmlns:r="{smart_ppt.R}"><p:sldIdLst>
        <p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>'''
        presentation_rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
        </Relationships>'''
        first_rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="../diagrams/data1.xml"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide9.xml"/>
        </Relationships>'''
        diagram = f'''<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="{smart_ppt.A}">
        <dgm:pt><dgm:txBody><a:p><a:r><a:t>流程节点</a:t></a:r></a:p></dgm:txBody></dgm:pt></dgm:dataModel>'''
        notes = slide(text_shape("备注", "封面备注", 12, 100, "body"))
        source = self.work / "messy.pptx"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("ppt/presentation.xml", presentation)
            archive.writestr("ppt/_rels/presentation.xml.rels", presentation_rels)
            archive.writestr("ppt/slides/slide2.xml", first_slide)
            archive.writestr("ppt/slides/slide1.xml", second_slide)
            archive.writestr("ppt/slides/_rels/slide2.xml.rels", first_rels)
            archive.writestr("ppt/diagrams/data1.xml", diagram)
            archive.writestr("ppt/notesSlides/notesSlide9.xml", notes)
        blocks, decorations, speaker_notes = smart_ppt.parse_document(source)
        by_text = {item["text"]: item for item in blocks}
        self.assertEqual(by_text["封面标题"]["kind"], "heading")
        self.assertEqual(by_text["封面标题"]["source"]["slide"], 1)
        self.assertEqual(by_text["第二章"]["source"]["slide"], 2)
        self.assertEqual(by_text["封面副标题"]["kind"], "subtitle")
        self.assertNotEqual(by_text["99%"]["kind"], "heading")
        self.assertIn("表格内容", by_text)
        self.assertIn("流程节点", by_text)
        self.assertIn("SOURCE: ACME", by_text)
        self.assertIn("INTELLIGENT PPT / 01", {item["text"] for item in decorations})
        self.assertEqual([item["text"] for item in speaker_notes], ["封面备注"])
        self.assertEqual(speaker_notes[0]["source"]["slide"], 1)

    def test_pptx_roundtrip_reuses_matched_outline_and_drops_card_ordinals(self):
        model, job, output, _ = self.build(ROOT / "examples" / "output" / "outline-beautified.pptx")
        self.assertEqual(len(job["pages"]), 6)
        self.assertEqual([page["plan"]["kind"] for page in job["pages"]],
                         ["cover", "overview", "content", "content", "content", "content"])
        self.assertFalse(any("（续）" in page["plan"]["title"] for page in job["pages"]))
        self.assertFalse(any(smart_ppt.re.fullmatch(r"0\d", item["text"]) for item in model["blocks"]))
        decoration_texts = {item["text"] for item in model["decorations"]}
        self.assertIn("INTELLIGENT PPT / 01", decoration_texts)
        self.assertIn("SOURCE → STRUCTURE → SLIDES", decoration_texts)
        self.assert_valid_deck(model, job, output)

    def test_unmatched_source_outline_remains_content(self):
        source = self.work / "custom-outline.txt"
        values = [
            ("heading", "演示文稿", 1), ("heading", "目录", 2),
            ("paragraph", "第一章", 0), ("paragraph", "自定义目录说明", 0),
            ("heading", "第一章", 2), ("paragraph", "第一章正文", 0),
            ("heading", "第二章", 2), ("paragraph", "第二章正文", 0),
        ]
        blocks = []
        for index, (kind, value, level) in enumerate(values, 1):
            item = smart_ppt.block(kind, value, {"line": index}, level)
            item.update({"id": f"b{index:04d}", "numbers": []})
            blocks.append(item)
        model = smart_ppt.make_model(source, blocks)
        pages = smart_ppt.plan_pages(model)
        self.assertIsNone(smart_ppt.matched_source_overview(model))
        outline = next(page for page in pages if page["plan"]["kind"] == "content" and page["plan"]["title"] == "目录")
        self.assertIn("自定义目录说明", [item["text"] for item in outline["plan"]["items"]])

    def test_long_overview_is_paginated_inside_canvas(self):
        source = self.work / "long.txt"
        blocks = [smart_ppt.block("heading", "长文档", {"line": 1}, 1)]
        for index in range(10):
            blocks.append(smart_ppt.block("heading", f"第 {index + 1} 章", {"line": index * 2 + 2}, 2))
            blocks.append(smart_ppt.block("paragraph", f"第 {index + 1} 章正文", {"line": index * 2 + 3}))
        for index, item in enumerate(blocks, 1):
            item["id"] = f"b{index:04d}"
            item["numbers"] = []
        model = smart_ppt.make_model(source, blocks)
        pages = smart_ppt.plan_pages(model)
        overviews = [page for page in pages if page["plan"]["kind"] == "overview"]
        self.assertEqual(len(overviews), 2)
        self.assertEqual([page["plan"]["overview_start"] for page in overviews], [0, 6])
        for page in pages:
            for element in page["page"]["elements"]:
                self.assertGreaterEqual(element["x"], 0)
                self.assertGreaterEqual(element["y"], 0)
                self.assertLessEqual(element["x"] + element["w"], 1280)
                self.assertLessEqual(element["y"] + element["h"], 720)

    def test_empty_and_unsupported_inputs_fail(self):
        empty = self.work / "empty.md"
        empty.write_text("\n\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "没有可识别的正文"):
            smart_ppt.parse_document(empty)
        with self.assertRaisesRegex(ValueError, "仅支持"):
            smart_ppt.parse_document(self.work / "input.pdf")

    def test_job_and_audit_files_are_json(self):
        model, job, output, _ = self.build(ROOT / "examples" / "outline.md")
        args = type("Args", (), {"job": str(self.work / "job.json"), "pptx": str(output)})()
        smart_ppt.command_audit(args)
        audit = json.loads((self.work / "fidelity-audit.json").read_text(encoding="utf-8"))
        self.assertEqual(audit["matched_blocks"], len(model["blocks"]))
        self.assertEqual(audit["missing_blocks"], [])
        self.assertEqual(audit["slides"], len(job["pages"]))


if __name__ == "__main__":
    unittest.main()
