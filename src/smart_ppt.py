# -*- coding: utf-8 -*-
import argparse
import base64
import json
import posixpath
import re
import struct
import time
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
P159 = "http://schemas.microsoft.com/office/powerpoint/2015/09/main"
NS = {"p": P, "a": A, "w": W, "m": M, "p14": P14, "p159": P159}

for prefix, uri in [("p", P), ("a", A), ("r", R), ("mc", MC), ("p14", P14), ("p159", P159)]:
    ET.register_namespace(prefix, uri)

FONT = "Microsoft YaHei"
THEMES = {
    "paper": {
        "background": "#F3F1EB", "ink": "#153B3C", "muted": "#647472",
        "accent": "#087F73", "secondary": "#E76F51", "card": "#FFFFFF", "line": "#D5DEDA",
    },
    "midnight": {
        "background": "#101820", "ink": "#F4F1E8", "muted": "#A9B6BC",
        "accent": "#56C7B7", "secondary": "#FFB65C", "card": "#182832", "line": "#33444D",
    },
    "azure": {
        "background": "#F3F7FC", "ink": "#142B4A", "muted": "#60708A",
        "accent": "#2563EB", "secondary": "#E35D6A", "card": "#FFFFFF", "line": "#D5E1F0",
    },
}
THEME = dict(THEMES["paper"])


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def block(kind, text, source, level=0):
    return {"kind": kind, "text": clean(text), "level": level, "source": source}


def explicit_note(text):
    match = re.match(r"^(?:备注|讲稿|演讲备注|注释|notes?)\s*[:：]\s*(.+)$", text, re.I)
    return match.group(1) if match else None


def office_paragraph_text(paragraph):
    parts = []
    for node in paragraph.iter():
        if node.tag in {f"{{{W}}}t", f"{{{A}}}t", f"{{{M}}}t"}:
            parts.append(node.text or "")
        elif node.tag in {f"{{{W}}}tab", f"{{{A}}}tab"}:
            parts.append(" ")
        elif node.tag in {f"{{{W}}}br", f"{{{A}}}br"}:
            parts.append("\n")
    return clean("".join(parts))


def join_wrapped(parts):
    value = ""
    for part in parts:
        part = clean(part)
        if not part:
            continue
        separator = " " if re.search(r"[A-Za-z0-9]$", value) and re.match(r"^[A-Za-z0-9]", part) else ""
        value += separator + part
    return clean(value)


def image_extension(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    raise ValueError("图片仅支持有效的 PNG 或 JPEG 文件")


def resolve_image(source_path, reference, line):
    reference = reference.strip().strip("<>")
    if reference.startswith("data:image/"):
        match = re.match(r"data:image/(?:png|jpeg);base64,(.+)$", reference, re.I | re.S)
        if not match:
            raise ValueError(f"第 {line} 行图片不是受支持的 Base64 PNG/JPEG")
        try:
            data = base64.b64decode(match.group(1), validate=True)
        except ValueError as error:
            raise ValueError(f"第 {line} 行图片 Base64 数据无效") from error
        extension = image_extension(data)
        target = source_path.parent / "assets" / f"image-{line}{extension}"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target
    if re.match(r"https?://", reference, re.I):
        raise ValueError(f"第 {line} 行图片需要随文件上传，不会自动下载外部图片")
    target = Path(reference)
    if not target.is_absolute():
        target = source_path.parent / target
    target = target.resolve()
    if not target.is_file():
        raise ValueError(f"第 {line} 行图片不存在，请随大纲上传同名 PNG/JPEG：{reference}")
    image_extension(target.read_bytes()[:16])
    return target


def image_dimensions(path):
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"\xff\xd8\xff"):
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            length = int.from_bytes(data[offset + 2:offset + 4], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                return int.from_bytes(data[offset + 7:offset + 9], "big"), int.from_bytes(data[offset + 5:offset + 7], "big")
            offset += 2 + max(1, length)
    return 1600, 900


def parse_markdown(path):
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    blocks = []
    paragraph_parts = []
    paragraph_start = 1
    in_code = False
    in_notes = False
    in_formula = False
    formula_lines = []
    formula_start = 0

    def flush_paragraph():
        nonlocal paragraph_parts
        if paragraph_parts:
            blocks.append(block("paragraph", join_wrapped(paragraph_parts), {"line": paragraph_start}))
            paragraph_parts = []

    index = 0
    while index < len(lines):
        number = index + 1
        raw = lines[index]
        text = raw.strip()
        if in_formula:
            if text == "$$":
                blocks.append(block("formula", " ".join(formula_lines), {"line": formula_start}))
                in_formula = False
                formula_lines = []
            else:
                formula_lines.append(text)
            index += 1
            continue
        if text.startswith("```"):
            flush_paragraph()
            in_code = not in_code
            index += 1
            continue
        if in_code:
            if text:
                blocks.append(block("paragraph", text, {"line": number}))
            index += 1
            continue
        if text.lower() in {"::: notes", "::: note", "::: 备注"}:
            flush_paragraph()
            in_notes = True
            index += 1
            continue
        if in_notes:
            if text == ":::":
                in_notes = False
            elif text:
                blocks.append(block("note", text, {"line": number}))
            index += 1
            continue
        if not text:
            flush_paragraph()
            index += 1
            continue
        source = {"line": number}
        comment = re.fullmatch(r"<!--\s*(.*?)\s*-->", text)
        if comment:
            flush_paragraph()
            if comment.group(1):
                blocks.append(block("note", comment.group(1), source))
            index += 1
            continue
        quoted = re.match(r"^>\s*(.+)$", text)
        if quoted:
            text = quoted.group(1)
        note = explicit_note(text)
        if note is not None:
            flush_paragraph()
            blocks.append(block("note", note, source))
            index += 1
            continue
        next_text = lines[index + 1].strip() if index + 1 < len(lines) else ""
        if (re.fullmatch(r"=+|-+", next_text) and not re.match(r"^(?:#{1,6}|[-*+]|\d+[.)、])", text)):
            flush_paragraph()
            blocks.append(block("heading", text, source, 1 if next_text.startswith("=") else 2))
            index += 2
            continue
        if re.fullmatch(r"(?:-{3,}|\*{3,}|_{3,})", text):
            flush_paragraph()
            index += 1
            continue
        if text == "$$":
            flush_paragraph()
            in_formula = True
            formula_start = number
            index += 1
            continue
        formula = re.fullmatch(r"\$\$(.+?)\$\$|\$([^$]+)\$", text)
        if formula:
            flush_paragraph()
            blocks.append(block("formula", formula.group(1) or formula.group(2), source))
            index += 1
            continue
        image = re.fullmatch(r"!\[([^\]]*)\]\((.+)\)", text)
        if image:
            flush_paragraph()
            reference = image.group(2).strip()
            fallback = "图片" if reference.startswith("data:image/") else Path(reference).stem
            item = block("image", image.group(1) or fallback or "图片", source)
            item["asset"] = str(resolve_image(path, reference, number))
            blocks.append(item)
            index += 1
            continue
        heading = re.match(r"^(#{1,6})(?:\s+|(?=[\u4e00-\u9fff]))(.+)$", text)
        list_item = re.match(r"^(\s*)(?:[-*+]|\d{1,9}[.)、])(?:\s+|(?=[\u4e00-\u9fff]))(.+)$", raw)
        if heading:
            flush_paragraph()
            blocks.append(block("heading", heading.group(2), source, len(heading.group(1))))
        elif list_item:
            flush_paragraph()
            indent = len(list_item.group(1).expandtabs(4))
            blocks.append(block("bullet", list_item.group(2), source, min(6, 1 + indent // 2)))
        else:
            if not paragraph_parts:
                paragraph_start = number
            paragraph_parts.append(text)
        index += 1
    flush_paragraph()
    if in_formula:
        raise ValueError(f"第 {formula_start} 行公式缺少结束标记 $$")
    return blocks


def text_heading_level(text, numeric_sections=False):
    if re.match(r"^第.{1,8}(?:章|篇|部分)(?:\s+.+)?$", text):
        return 2
    if re.match(r"^第.{1,8}节(?:\s+.+)?$", text):
        return 3
    if re.match(r"^(?:[一二三四五六七八九十]+、|\d{1,2}、)\S+", text):
        return 2
    if re.match(r"^[（(][一二三四五六七八九十]+[）)]\s*\S+", text):
        return 3
    if numeric_sections and re.match(r"^\d{1,2}[.]\s*\S+", text):
        return 2
    return None


def parse_text(path):
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    nonempty = [(index, raw.strip()) for index, raw in enumerate(lines) if raw.strip()]
    numeric_indexes = [index for index, text in nonempty if re.match(r"^\d{1,2}[.]\s*\S+", text)]
    has_named_sections = any(text_heading_level(text) for _, text in nonempty)
    numeric_sections = False
    if not has_named_sections and len(numeric_indexes) >= 2:
        separated = 0
        for position, index in enumerate(numeric_indexes):
            next_index = numeric_indexes[position + 1] if position + 1 < len(numeric_indexes) else len(lines)
            if any(lines[item].strip() and not re.match(r"^\d{1,2}[.]\s*\S+", lines[item].strip())
                   for item in range(index + 1, next_index)):
                separated += 1
        numeric_sections = separated >= max(1, len(numeric_indexes) // 2)
    has_sections = has_named_sections or numeric_sections
    blocks = []
    paragraph_parts = []
    paragraph_start = 1

    def flush_paragraph():
        nonlocal paragraph_parts
        if paragraph_parts:
            blocks.append(block("paragraph", join_wrapped(paragraph_parts), {"line": paragraph_start}))
            paragraph_parts = []

    first_content_index = nonempty[0][0] if nonempty else -1
    for index, raw in enumerate(lines):
        number = index + 1
        text = raw.strip()
        if not text:
            flush_paragraph()
            continue
        source = {"line": number}
        note = explicit_note(text)
        if note is not None:
            flush_paragraph()
            blocks.append(block("note", note, source))
            continue
        level = text_heading_level(text, numeric_sections)
        if level:
            flush_paragraph()
            blocks.append(block("heading", text, source, level))
            continue
        if (index == first_content_index and has_sections and len(text) <= 60
                and not re.search(r"[。！？；.!?;]$", text)):
            flush_paragraph()
            blocks.append(block("heading", text, source, 1))
            continue
        list_item = re.match(r"^(\s*)(?:[-*•]|\d{1,9}[.)]|[（(]\d+[）)])(?:\s+|(?=[\u4e00-\u9fff]))(.+)$", raw)
        if list_item:
            flush_paragraph()
            indent = len(list_item.group(1).expandtabs(4))
            blocks.append(block("bullet", list_item.group(2), source, min(6, 1 + indent // 2)))
            continue
        if not paragraph_parts:
            paragraph_start = number
        paragraph_parts.append(text)
    flush_paragraph()
    return blocks


def parse_docx(path):
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        style_names = {}
        if "word/styles.xml" in archive.namelist():
            styles = ET.fromstring(archive.read("word/styles.xml"))
            for style in styles.findall("w:style", NS):
                name = style.find("w:name", NS)
                if name is not None:
                    style_names[style.get(f"{{{W}}}styleId")] = name.get(f"{{{W}}}val", "")
        blocks = []
        for number, paragraph in enumerate(root.findall(".//w:body//w:p", NS), 1):
            text = office_paragraph_text(paragraph)
            is_formula = paragraph.find(".//m:oMath", NS) is not None or paragraph.find(".//m:oMathPara", NS) is not None
            if not text:
                continue
            style = paragraph.find("w:pPr/w:pStyle", NS)
            style_id = style.get(f"{{{W}}}val", "") if style is not None else ""
            style_name = style_names.get(style_id, style_id).lower()
            heading = re.search(r"(?:heading|标题)\s*([1-6])", style_name)
            outline = paragraph.find("w:pPr/w:outlineLvl", NS)
            outline_level = int(outline.get(f"{{{W}}}val", "0")) + 1 if outline is not None else None
            source = {"paragraph": number, "style": style_id}
            note = explicit_note(text)
            if note is not None or re.search(r"备注|讲稿|comment|notes?", style_name, re.I):
                blocks.append(block("note", note if note is not None else text, source))
            elif is_formula:
                blocks.append(block("formula", text, source))
            elif style_name in {"title", "标题"}:
                blocks.append(block("heading", text, source, 1))
            elif heading or outline_level is not None:
                blocks.append(block("heading", text, source, int(heading.group(1)) if heading else outline_level))
            elif style_name in {"subtitle", "副标题"}:
                blocks.append(block("subtitle", text, source))
            elif paragraph.find("w:pPr/w:numPr", NS) is not None:
                level = paragraph.find("w:pPr/w:numPr/w:ilvl", NS)
                indent = int(level.get(f"{{{W}}}val", "0")) + 1 if level is not None else 1
                blocks.append(block("bullet", text, source, indent))
            else:
                blocks.append(block("paragraph", text, source))
        return blocks


def slide_number(name):
    return int(re.search(r"(\d+)\.xml$", name).group(1))


def shape_text(shape):
    paragraphs = []
    for paragraph in shape.findall(".//a:p", NS):
        value = office_paragraph_text(paragraph)
        if value:
            paragraphs.append(value)
    return paragraphs


def shape_font_size(shape):
    tags = {f"{{{A}}}rPr", f"{{{A}}}defRPr", f"{{{A}}}endParaRPr"}
    sizes = [int(node.get("sz")) / 100 for node in shape.iter() if node.tag in tags and node.get("sz")]
    return max(sizes, default=0)


def shape_xfrm(shape):
    for path_value in ("p:spPr/a:xfrm", "p:xfrm", "p:grpSpPr/a:xfrm"):
        transform = shape.find(path_value, NS)
        if transform is not None:
            return transform
    return None


def shape_position(shape, parents=None):
    transform = shape_xfrm(shape)
    offset = transform.find("a:off", NS) if transform is not None else None
    x = int(offset.get("x", "0")) / 9525 if offset is not None else 0
    y = int(offset.get("y", "0")) / 9525 if offset is not None else 0
    parent = parents.get(shape) if parents is not None else None
    if parent is None or parent.tag != f"{{{P}}}grpSp":
        return x, y
    parent_x, parent_y = shape_position(parent, parents)
    group = shape_xfrm(parent)
    child_offset = group.find("a:chOff", NS) if group is not None else None
    extent = group.find("a:ext", NS) if group is not None else None
    child_extent = group.find("a:chExt", NS) if group is not None else None
    child_x = int(child_offset.get("x", "0")) / 9525 if child_offset is not None else 0
    child_y = int(child_offset.get("y", "0")) / 9525 if child_offset is not None else 0
    scale_x = int(extent.get("cx", "1")) / max(1, int(child_extent.get("cx", "1"))) if extent is not None and child_extent is not None else 1
    scale_y = int(extent.get("cy", "1")) / max(1, int(child_extent.get("cy", "1"))) if extent is not None and child_extent is not None else 1
    return parent_x + (x - child_x) * scale_x, parent_y + (y - child_y) * scale_y


def shape_top(shape, parents=None):
    return shape_position(shape, parents)[1]


def shape_left(shape, parents=None):
    return shape_position(shape, parents)[0]


def placeholder_type(shape):
    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    return placeholder.get("type", "") if placeholder is not None else ""


def relationship_targets(archive, part):
    name = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if name not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read(name))
    result = {}
    for relation in root:
        target = relation.get("Target", "")
        if relation.get("TargetMode") == "External" or not target:
            continue
        result[relation.get("Id", "")] = {
            "type": relation.get("Type", ""),
            "target": posixpath.normpath(posixpath.join(posixpath.dirname(part), target)),
        }
    return result


def presentation_slides(archive):
    available = {name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)}
    try:
        root = ET.fromstring(archive.read("ppt/presentation.xml"))
        relationships = relationship_targets(archive, "ppt/presentation.xml")
        ordered = []
        for identifier in root.findall(".//p:sldId", NS):
            relation = relationships.get(identifier.get(f"{{{R}}}id"), {})
            target = relation.get("target")
            if target in available and target not in ordered:
                ordered.append(target)
        ordered.extend(sorted(available - set(ordered), key=slide_number))
        return ordered
    except (KeyError, ET.ParseError):
        return sorted(available, key=slide_number)


def small_page_number(value):
    return bool(re.fullmatch(r"\d{1,2}(?:\s*/\s*\d{1,2})?", value))


def micro_brand_label(item):
    if item["kind"] in {"heading", "subtitle"} or not (item["top"] <= 90 or item["top"] >= 590):
        return False
    if not 0 < item["font_size"] <= 12:
        return False
    value = item["text"]
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9 ./_|·:—→-]*", value):
        return False
    if re.search(r"\b(?:SOURCE|REFERENCES?|DATA)\s*:", value):
        return False
    return bool(re.search(r"\s/\s*\d{1,2}$", value) or "→" in value
                or value in {"STRUCTURE", "CONTENTS", "CONTENT / FORM"})


def parse_pptx(path):
    blocks = []
    notes = []
    with zipfile.ZipFile(path) as archive:
        slides = presentation_slides(archive)
        for index, slide_path in enumerate(slides, 1):
            root = ET.fromstring(archive.read(slide_path))
            parents = {child: parent for parent in root.iter() for child in parent}
            relationships = relationship_targets(archive, slide_path)
            elements = [element for element in root.iter() if element.tag in {f"{{{P}}}sp", f"{{{P}}}graphicFrame"}]
            shapes = [shape for shape in elements if shape_text(shape)]
            title_shape = next((shape for shape in shapes if placeholder_type(shape) in {"title", "ctrTitle"}), None)
            if title_shape is None and shapes:
                pool = [shape for shape in shapes if shape.tag == f"{{{P}}}sp"] or shapes
                title_zone = 400 if index == 1 else 220
                candidates = []
                for shape in pool:
                    value = " ".join(shape_text(shape))
                    if (shape_top(shape, parents) <= title_zone and len(value) <= 160
                            and not re.fullmatch(r"[-+]?\d+(?:\.\d+)?%?", value)
                            and not small_page_number(value) and shape_font_size(shape) >= 16):
                        candidates.append(shape)
                if not candidates:
                    candidates = [shape for shape in pool if shape_top(shape, parents) <= title_zone
                                  and not small_page_number(" ".join(shape_text(shape)))]
                if candidates:
                    topmost = min(shape_top(shape, parents) for shape in candidates)
                    nearest = [shape for shape in candidates if shape_top(shape, parents) <= topmost + 90]
                    title_shape = max(nearest, key=lambda shape: shape_font_size(shape))
                else:
                    title_shape = min(pool, key=lambda shape: (shape_top(shape, parents), shape_left(shape, parents)))
            title_size = shape_font_size(title_shape) if title_shape is not None else 0
            title_top = shape_top(title_shape, parents) if title_shape is not None else 0
            subtitle_shape = next((shape for shape in shapes if placeholder_type(shape) == "subTitle"), None)
            if title_shape is not None and subtitle_shape is None:
                subtitle_candidates = []
                for shape in shapes:
                    if shape is title_shape or shape.tag != f"{{{P}}}sp":
                        continue
                    delta = shape_top(shape, parents) - title_top
                    size = shape_font_size(shape)
                    value = " ".join(shape_text(shape))
                    if (24 <= delta <= (300 if index == 1 else 90) and 12 <= size < title_size
                            and not small_page_number(value)):
                        subtitle_candidates.append(shape)
                if subtitle_candidates:
                    subtitle_shape = min(subtitle_candidates, key=lambda shape: shape_top(shape, parents))
            title_used = False
            ordered_shapes = sorted(shapes, key=lambda shape: (shape_top(shape, parents), shape_left(shape, parents)))
            for shape_index, shape in enumerate(ordered_shapes, 1):
                paragraph_nodes = [paragraph for paragraph in shape.findall(".//a:p", NS) if office_paragraph_text(paragraph)]
                paragraphs = shape_text(shape)
                has_bullets = any(paragraph.find("a:pPr/a:buChar", NS) is not None
                                  or paragraph.find("a:pPr/a:buAutoNum", NS) is not None for paragraph in paragraph_nodes)
                for paragraph_index, value in enumerate(paragraphs, 1):
                    source = {"slide": index, "shape": shape_index, "paragraph": paragraph_index}
                    if shape is title_shape and not title_used:
                        item = block("heading", value, source, 1 if index == 1 else 2)
                        title_used = True
                    elif shape is subtitle_shape or (shape is title_shape and index == 1):
                        item = block("subtitle", value, source)
                    elif len(paragraphs) > 1 or has_bullets:
                        item = block("bullet", value, source)
                    else:
                        item = block("paragraph", value, source)
                    item["font_size"] = shape_font_size(shape)
                    item["top"] = shape_top(shape, parents)
                    item["left"] = shape_left(shape, parents)
                    blocks.append(item)
            for frame in elements:
                if frame.tag != f"{{{P}}}graphicFrame" or shape_text(frame):
                    continue
                diagram_ids = [node.get(f"{{{R}}}dm") for node in frame.iter() if node.get(f"{{{R}}}dm")]
                for relation_id in diagram_ids[:1]:
                    relation = relationships.get(relation_id, {})
                    target = relation.get("target")
                    if not relation.get("type", "").endswith("/diagramData") or target not in archive.namelist():
                        continue
                    diagram = ET.fromstring(archive.read(target))
                    for paragraph_index, value in enumerate(shape_text(diagram), 1):
                        item = block("bullet", value, {"slide": index, "shape": 0, "paragraph": paragraph_index})
                        item.update({"font_size": 0, "top": 200, "left": 0, "from_diagram": True})
                        blocks.append(item)
            for relation in relationships.values():
                if not relation.get("type", "").endswith("/notesSlide") or relation["target"] not in archive.namelist():
                    continue
                notes_root = ET.fromstring(archive.read(relation["target"]))
                for shape in notes_root.findall(".//p:sp", NS):
                    if placeholder_type(shape) != "body":
                        continue
                    for value in shape_text(shape):
                        notes.append(block("note", value, {"slide": index}))
    repeated_slides = {}
    ordinals_by_slide = {}
    for item in blocks:
        repeated_slides.setdefault(item["text"], set()).add(item["source"]["slide"])
        if re.fullmatch(r"0\d", item["text"]) and item["kind"] not in {"heading", "subtitle"}:
            ordinals_by_slide.setdefault(item["source"]["slide"], []).append(item)
    decorations = []
    content = []
    for item in blocks:
        header_footer = item["top"] <= 90 or item["top"] >= 590
        repeated = (not item.get("from_diagram") and len(repeated_slides[item["text"]]) >= 3
                    and item["kind"] not in {"heading", "subtitle"}
                    and ((0 < item["font_size"] <= 14) or header_footer))
        small_number = (small_page_number(item["text"]) and 0 < item["font_size"] <= 14
                        and item["kind"] not in {"heading", "subtitle"})
        peers = ordinals_by_slide.get(item["source"]["slide"], [])
        ordinal = item in peers and (len(peers) >= 2 or sum(peer["text"] == item["text"] for peer in peers) >= 2
                                     or any(other is not item and re.match(rf"{re.escape(item['text'])}\s+\S", other["text"])
                                            for other in blocks if other["source"]["slide"] == item["source"]["slide"]))
        micro_brand = micro_brand_label(item)
        if repeated or small_number or ordinal or micro_brand:
            reasons = []
            if repeated:
                reasons.append("跨页重复页眉页脚")
            if small_number or ordinal:
                reasons.append("页码或卡片序号")
            if micro_brand:
                reasons.append("小号品牌或导航标签")
            item["decoration_reason"] = "、".join(reasons)
            decorations.append(item)
        else:
            content.append(item)
    return content, decorations, notes


def parse_document(path):
    suffix = path.suffix.lower()
    decorations = []
    notes = []
    if suffix in {".md", ".markdown"}:
        blocks = parse_markdown(path)
    elif suffix == ".txt":
        blocks = parse_text(path)
    elif suffix == ".docx":
        blocks = parse_docx(path)
    elif suffix == ".pptx":
        blocks, decorations, notes = parse_pptx(path)
    else:
        raise ValueError("仅支持 .docx、.md、.markdown、.txt、.pptx")
    notes.extend(item for item in blocks if item["kind"] == "note")
    blocks = [item for item in blocks if item["kind"] != "note"]
    if not blocks:
        raise ValueError("输入中没有可识别的正文")
    for index, item in enumerate(blocks, 1):
        item["id"] = f"b{index:04d}"
        item["numbers"] = re.findall(r"(?<![A-Za-z])[-+]?\d+(?:\.\d+)?%?", item["text"])
    for index, item in enumerate(notes, 1):
        item["id"] = f"n{index:04d}"
    return blocks, decorations, notes


def make_model(path, blocks, decorations=None, notes=None):
    headings = [item for item in blocks if item["kind"] == "heading"]
    title = headings[0]["text"] if headings else path.stem
    title_id = headings[0]["id"] if headings else None
    sections = []
    lead = []
    current = None
    title_item = headings[0] if headings else None
    remaining_levels = [item["level"] for item in headings if item is not title_item]
    section_level = min(remaining_levels) if remaining_levels else 2
    for item in blocks:
        if item is title_item:
            continue
        if item["kind"] == "heading" and item["level"] <= section_level:
            current = {"title": item["text"], "heading_id": item["id"], "items": []}
            sections.append(current)
        elif current is None:
            lead.append(item)
        else:
            current["items"].append(item)
    if not sections:
        sections = [{"title": title, "heading_id": title_id, "items": [item for item in blocks if item["id"] != title_id]}]
        lead = []
    return {
        "source": {"path": str(path), "format": path.suffix.lower().lstrip(".")},
        "title": title,
        "title_id": title_id,
        "lead": lead,
        "sections": sections,
        "blocks": blocks,
        "decorations": decorations or [],
        "notes": notes or [],
    }


def choose_layout(section, index):
    items = section["items"]
    title = section["title"]
    if any(item["kind"] == "image" for item in items):
        return "image" if len(items) == 1 else "gallery"
    if len(items) == 1 and items[0]["kind"] == "formula":
        return "formula"
    if not items or len(items) == 1:
        return "statement"
    if len(items) == 2:
        return "compare" if re.search(r"对比|比较|versus|\bvs\b|差异", title, re.I) else "editorial"
    if any(len(item["text"]) > 120 for item in items):
        return "editorial"
    if re.search(r"流程|步骤|路径|阶段|计划", title):
        return "timeline"
    if sum(bool(item["numbers"]) for item in items) * 2 >= len(items):
        return "data"
    if len(items) == 4:
        return "grid"
    if len(items) == 3:
        return ["cards", "editorial", "focus"][index % 3]
    return "editorial"


def split_items(items):
    if not items:
        return [[]]
    limit = 2 if any(len(item["text"]) > 120 for item in items) else 4
    chunks = []
    current = []
    length = 0
    for item in items:
        if current and (len(current) >= limit or length + len(item["text"]) > 330):
            chunks.append(current)
            current = []
            length = 0
        current.append(item)
        length += len(item["text"])
    if current:
        chunks.append(current)
    if len(chunks) > 1 and len(chunks[-1]) == 1 and len(chunks[-2]) > 2:
        chunks[-1].insert(0, chunks[-2].pop())
    return chunks


def text_units(value):
    return sum(1 if unicodedata.east_asian_width(char) in {"W", "F", "A"} else 0.56 for char in value)


def estimated_lines(value, width, size_pt):
    capacity = max(1, width / (size_pt * 96 / 72))
    return sum(max(1, int((text_units(part) + capacity - 1) // capacity)) for part in str(value).split("\n"))


def fit_font_size(value, width, height, size, minimum=10):
    candidate = size
    while candidate > minimum:
        line_height = candidate * 96 / 72 * 1.1
        if estimated_lines(value, width, candidate) * line_height <= height:
            break
        candidate -= 0.5
    return round(candidate, 1)


def text(x, y, w, h, value, size=16, color=None, bold=False, align="left"):
    size = fit_font_size(value, w, h, size)
    paragraphs = [{"align": align, "lineSpacingPct": 110, "spaceAfterPt": 0, "bullet": False,
                   "runs": [{"text": part, "sizePt": size, "bold": bold, "italic": False,
                             "color": color or THEME["ink"], "font": FONT}]}
                  for part in str(value).split("\n")]
    return {"type": "text", "x": x, "y": y, "w": w, "h": h, "valign": "top", "paragraphs": paragraphs}


def shape(kind, x, y, w, h, fill, stroke=None):
    result = {"type": "shape", "shape": kind, "x": x, "y": y, "w": w, "h": h, "fill": fill}
    if stroke:
        result["stroke"] = {"color": stroke, "widthPt": 1}
    return result


def body_size(value, width_chars=28):
    lines = max(1, (len(value) + width_chars - 1) // width_chars)
    if lines >= 5:
        return 12.5
    if lines >= 3:
        return 14
    return 16


def base_page(title_value, page_number, section_index, section_count, motion, fade):
    elements = [
        shape("rect", 0, 0, 1280, 720, THEME["background"]),
        text(170, 38, 400, 28, "CONTENT / FORM", 10, THEME["accent"], True),
        text(170, 76, 940, 66, title_value, 30, THEME["ink"], True),
        shape("line", 170, 156, 1010, 1, "#00000000", THEME["line"]),
        text(1080, 46, 100, 28, f"{page_number:02d}", 12, THEME["muted"], True, "right"),
    ]
    fade.extend([1, 2])
    if section_count:
        top = 205
        gap = min(66, 300 / max(1, section_count - 1))
        for index in range(section_count):
            y = round(top + index * gap)
            elements.append(text(82, y - 9, 42, 28, f"{index + 1:02d}", 11,
                                 THEME["accent"] if index == section_index else THEME["muted"],
                                 index == section_index))
        elements.append(shape("line", 56, top, 1, round(gap * (section_count - 1)) or 1,
                              "#00000000", THEME["line"]))
        cursor_y = round(top + section_index * gap - 6)
        motion.append({"element_index": len(elements), "name": "!!section-cursor"})
        elements.append(shape("ellipse", 50, cursor_y, 13, 13, THEME["secondary"]))
        progress_h = max(1, round(gap * section_index))
        motion.append({"element_index": len(elements), "name": "!!section-progress"})
        elements.append(shape("rect", 54, top, 5, progress_h, THEME["accent"]))
    return elements


def image(path, x, y, w, h, alt=""):
    source = Path(path)
    source_width, source_height = image_dimensions(source)
    scale = min(w / source_width, h / source_height)
    width = max(1, round(source_width * scale))
    height = max(1, round(source_height * scale))
    return {"type": "image", "path": str(source), "alt": alt,
            "x": round(x + (w - width) / 2), "y": round(y + (h - height) / 2), "w": width, "h": height}


def render_items(layout, items, elements, fade):
    start = len(elements)
    if layout == "formula":
        value = items[0]["text"]
        elements.append(shape("roundRect", 190, 220, 900, 280, THEME["card"], THEME["line"]))
        formula_text = text(240, 270, 800, 180, value, 30, THEME["ink"], False, "center")
        formula_text["paragraphs"][0]["runs"][0]["font"] = "Cambria Math"
        elements.append(formula_text)
    elif layout == "image":
        item = items[0]
        elements.append(image(item["asset"], 190, 190, 900, 360, item["text"]))
        elements.append(text(190, 575, 900, 40, item["text"], 14, THEME["muted"], False, "center"))
    elif layout == "gallery":
        for index, item in enumerate(items):
            x = 175 + (index % 2) * 500
            y = 190 + (index // 2) * 210
            if item["kind"] == "image":
                elements.append(image(item["asset"], x, y, 455, 160, item["text"]))
                elements.append(text(x, y + 165, 455, 32, item["text"], 12, THEME["muted"], False, "center"))
            else:
                elements.append(shape("roundRect", x, y, 455, 185, THEME["card"], THEME["line"]))
                elements.append(text(x + 24, y + 25, 407, 130, item["text"], 17, THEME["ink"]))
    elif layout == "statement":
        value = items[0]["text"] if items else ""
        elements.append(shape("rect", 180, 230, 7, 210, THEME["secondary"]))
        elements.append(text(235, 220, 830, 250, value, 28, THEME["ink"], True))
    elif layout == "compare":
        for index, item in enumerate(items):
            x = 175 + index * 505
            elements.append(shape("roundRect", x, 220, 470, 320, THEME["card"], THEME["line"]))
            elements.append(text(x + 30, 250, 90, 35, f"0{index + 1}", 16, THEME["secondary"], True))
            elements.append(text(x + 30, 320, 410, 170, item["text"], 21, THEME["ink"], True))
    elif layout == "cards":
        gap = 22
        width = 316
        for index, item in enumerate(items):
            x = 170 + index * (width + gap)
            elements.append(shape("roundRect", x, 215, width, 350, THEME["card"], THEME["line"]))
            elements.append(text(x + 24, 242, 100, 58, f"{index + 1:02d}", 32, THEME["secondary"], True))
            elements.append(text(x + 24, 340, width - 48, 170, item["text"], body_size(item["text"], 15), THEME["ink"], True))
    elif layout == "grid":
        for index, item in enumerate(items):
            x = 170 + (index % 2) * 510
            y = 200 + (index // 2) * 205
            elements.append(shape("roundRect", x, y, 486, 178, THEME["card"], THEME["line"]))
            elements.append(text(x + 24, y + 22, 54, 40, f"{index + 1:02d}", 22, THEME["secondary"], True))
            elements.append(text(x + 92, y + 22, 360, 128, item["text"], body_size(item["text"], 21), THEME["ink"]))
    elif layout == "timeline":
        elements.append(shape("line", 205, 280, 860, 1, "#00000000", THEME["accent"]))
        gap = 840 // max(1, len(items) - 1) if len(items) > 1 else 0
        for index, item in enumerate(items):
            x = 190 + index * gap if len(items) > 1 else 540
            elements.append(shape("ellipse", x, 258, 44, 44, THEME["accent"]))
            elements.append(text(x + 5, 267, 34, 26, str(index + 1), 12, "#FFFFFF", True, "center"))
            box_x = max(160, min(1000, x - 95))
            elements.append(text(box_x, 350, 230, 180, item["text"], body_size(item["text"], 14), THEME["ink"], index == 0, "center"))
    elif layout == "data":
        for index, item in enumerate(items):
            y = 195 + index * 102
            number = item["numbers"][0] if item["numbers"] else f"{index + 1:02d}"
            elements.append(text(180, y, 210, 74, number, 38, THEME["secondary"], True))
            elements.append(text(430, y + 3, 700, 82, item["text"], body_size(item["text"], 40), THEME["ink"]))
            if index < len(items) - 1:
                elements.append(shape("line", 430, y + 88, 700, 1, "#00000000", THEME["line"]))
    elif layout == "focus":
        elements.append(shape("donut", 190, 230, 270, 270, THEME["accent"]))
        elements.append(text(232, 320, 185, 80, f"{len(items):02d}", 48, THEME["ink"], True, "center"))
        for index, item in enumerate(items):
            y = 205 + index * 125
            elements.append(text(560, y, 50, 35, f"{index + 1:02d}", 16, THEME["secondary"], True))
            elements.append(text(630, y, 500, 102, item["text"], body_size(item["text"], 28), THEME["ink"], index == 0))
    else:
        for index, item in enumerate(items):
            y = 194 + index * (320 // max(1, len(items)))
            elements.append(text(180, y, 65, 40, f"{index + 1:02d}", 18, THEME["secondary"], True))
            elements.append(text(275, y, 850, 118, item["text"], body_size(item["text"], 48), THEME["ink"], len(items) == 1))
            if index < len(items) - 1:
                elements.append(shape("line", 275, y + 102, 850, 1, "#00000000", THEME["line"]))
    fade.extend(range(start, len(elements)))


def cover_page(model):
    lead_text = [item for item in model["lead"] if item["kind"] != "image"]
    cover_image = next((item for item in model["lead"] if item["kind"] == "image"), None)
    subtitle = "\n".join(item["text"] for item in lead_text) if lead_text else "内容解析 · 自动分页 · 原生可编辑"
    subtitle_size = 14 if len(subtitle) > 110 else 17
    visual = ([image(cover_image["asset"], 790, 105, 390, 450, cover_image["text"])] if cover_image else
              [shape("ellipse", 890, 90, 290, 290, THEME["accent"]),
               shape("donut", 830, 330, 330, 330, THEME["secondary"])])
    elements = [
        shape("rect", 0, 0, 1280, 720, THEME["background"]),
        *visual,
        text(80, 64, 500, 30, "INTELLIGENT PPT / 01", 11, THEME["accent"], True),
        text(80, 175, 760, 190, model["title"], 42, THEME["ink"], True),
        text(84, 400, 650, 170, subtitle, subtitle_size, THEME["muted"]),
        shape("line", 84, 590, 1090, 1, "#00000000", THEME["line"]),
        text(84, 618, 450, 28, "SOURCE → STRUCTURE → SLIDES", 10, THEME["muted"], True),
        text(1070, 612, 100, 34, "01", 14, THEME["ink"], True, "right"),
    ]
    return {"background": THEME["background"], "elements": elements}, list(range(3, 6))


def overview_page(sections, offset=0, total=None, title="内容结构", count_text=None):
    elements = [
        shape("rect", 0, 0, 1280, 720, THEME["background"]),
        text(80, 58, 300, 28, "STRUCTURE", 11, THEME["accent"], True),
        text(80, 104, 600, 70, title, 36, THEME["ink"], True),
        text(970, 110, 190, 50, count_text or f"{total if total is not None else len(sections):02d} 部分", 18, THEME["secondary"], True, "right"),
    ]
    for index, section in enumerate(sections):
        x = 80 + (index % 2) * 575
        y = 230 + (index // 2) * 150
        elements.append(text(x, y, 70, 48, f"{offset + index + 1:02d}", 24, THEME["secondary"], True))
        elements.append(text(x + 92, y, 440, 92, section["title"], 20, THEME["ink"], True))
        elements.append(shape("line", x + 92, y + 100, 420, 1, "#00000000", THEME["line"]))
    return {"background": THEME["background"], "elements": elements}


def overview_title_key(value):
    value = re.sub(r"^(?:第\s*)?\d{1,3}\s*(?:[章节]|[.、．:：-])?\s*", "", clean(value).casefold())
    return re.sub(r"[\s.、．:：-]+", "", value)


def matched_source_overview(model):
    if len(model["sections"]) < 3:
        return None
    source = model["sections"][0]
    if not re.fullmatch(r"(?:内容结构|目录|大纲|CONTENTS)", source["title"], re.I):
        return None
    later = model["sections"][1:]
    section_keys = {overview_title_key(section["title"]): index for index, section in enumerate(later)}
    display_titles = {}
    count_text = None
    matched = 0
    for item in source["items"]:
        value = item["text"]
        if re.fullmatch(r"\d{1,3}", value):
            continue
        if re.fullmatch(r"\d{1,3}\s*(?:个\s*)?(?:部分|章节|章|节|主题|sections?|parts?)", value, re.I):
            if count_text is not None and count_text != value:
                return None
            count_text = value
            continue
        key = overview_title_key(value)
        if not key or key not in section_keys:
            return None
        display_titles[section_keys[key]] = value
        matched += 1
    if not matched:
        return None
    display_sections = [dict(section, title=display_titles.get(index, section["title"]))
                        for index, section in enumerate(later)]
    return {"source": source, "sections": display_sections, "count_text": count_text}


def plan_pages(model):
    cover_sources = ([model["title_id"]] if model["title_id"] else []) + [item["id"] for item in model["lead"]]
    plans = [{"kind": "cover", "title": model["title"], "layout": "cover", "source_ids": cover_sources}]
    source_overview = matched_source_overview(model)
    source_overview_title = (model["sections"] and re.fullmatch(r"(?:内容结构|目录|大纲|CONTENTS)",
                                                                  model["sections"][0]["title"], re.I))
    content_sections = model["sections"][1:] if source_overview else model["sections"]
    overview_sections = source_overview["sections"] if source_overview else content_sections
    if source_overview or (len(content_sections) >= 3 and not source_overview_title):
        overview_title = source_overview["source"]["title"] if source_overview else "内容结构"
        for start in range(0, len(overview_sections), 6):
            chunk = overview_sections[start:start + 6]
            source_ids = [section["heading_id"] for section in chunk if section["heading_id"]]
            if source_overview and start == 0:
                source = source_overview["source"]
                source_ids += ([source["heading_id"]] if source["heading_id"] else []) + [item["id"] for item in source["items"]]
            plans.append({"kind": "overview", "title": overview_title if start == 0 else overview_title + "（续）",
                          "layout": "overview", "overview_start": start, "overview_sections": chunk,
                          "overview_title": overview_title if start == 0 else overview_title + "（续）",
                          "overview_count": source_overview["count_text"] if source_overview else None,
                          "source_ids": source_ids})
    for section_index, section in enumerate(content_sections):
        layout = choose_layout(section, section_index)
        chunks = split_items(section["items"])
        for chunk_index, chunk in enumerate(chunks):
            suffix = "（续）" if chunk_index else ""
            source_ids = [section["heading_id"]] if section["heading_id"] and chunk_index == 0 else []
            source_ids += [item["id"] for item in chunk]
            plans.append({"kind": "content", "title": section["title"] + suffix, "layout": layout,
                          "section_index": section_index, "section_count": len(content_sections),
                          "items": [{"id": item["id"], "kind": item["kind"], "text": item["text"],
                                     "numbers": item["numbers"], "asset": item.get("asset")} for item in chunk],
                          "source_ids": source_ids})
    pages = []
    for page_index, plan in enumerate(plans, 1):
        motion = []
        fade = []
        if plan["kind"] == "cover":
            page, fade = cover_page(model)
        elif plan["kind"] == "overview":
            page = overview_page(plan["overview_sections"], plan["overview_start"], len(content_sections),
                                 plan["overview_title"], plan["overview_count"])
            fade = list(range(1, len(page["elements"])))
        else:
            elements = base_page(plan["title"], page_index, plan["section_index"], plan["section_count"], motion, fade)
            render_items(plan["layout"], plan["items"], elements, fade)
            page = {"background": THEME["background"], "elements": elements}
        pages.append({"number": page_index, "plan": plan, "page": page, "motion": motion, "fade": fade})
    return pages


def command_plan(args):
    global THEME
    started = time.perf_counter()
    source = Path(args.input).resolve()
    out = Path(args.out).resolve()
    THEME = dict(THEMES[args.style])
    parse_started = time.perf_counter()
    blocks, decorations, notes = parse_document(source)
    model = make_model(source, blocks, decorations, notes)
    model["style"] = args.style
    parse_seconds = time.perf_counter() - parse_started
    plan_started = time.perf_counter()
    pages = plan_pages(model)
    plan_seconds = time.perf_counter() - plan_started
    write_started = time.perf_counter()
    write_json(out / "content.json", model)
    for page in pages:
        write_json(out / "pages" / f"page-{page['number']:02d}.json", page["page"])
    job = {"source": str(source), "content_file": "content.json", "page_count": len(pages), "pages": pages}
    write_json(out / "job.json", job)
    write_seconds = time.perf_counter() - write_started
    timings = {"input": str(source), "stages": {
        "parse_seconds": round(parse_seconds, 6), "plan_seconds": round(plan_seconds, 6),
        "write_seconds": round(write_seconds, 6), "total_seconds": round(time.perf_counter() - started, 6)}}
    write_json(out / "timings.json", timings)
    print(json.dumps({"blocks": len(blocks), "sections": len(model["sections"]), "pages": len(pages),
                      "output": str(out), "timings": timings["stages"]}, ensure_ascii=False))


def effect_xml(ctn_id, spid, delay, dur):
    return f"""<p:par>
  <p:cTn id="{ctn_id}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="withEffect">
    <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>
    <p:childTnLst>
      <p:set>
        <p:cBhvr>
          <p:cTn id="{ctn_id + 1}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>
          <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>
          <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>
        </p:cBhvr>
        <p:to><p:strVal val="visible"/></p:to>
      </p:set>
      <p:animEffect transition="in" filter="fade">
        <p:cBhvr>
          <p:cTn id="{ctn_id + 2}" dur="{dur}"/>
          <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>
        </p:cBhvr>
      </p:animEffect>
    </p:childTnLst>
  </p:cTn>
</p:par>"""


def transition_xml(duration=650):
    return f'''<mc:AlternateContent xmlns:mc="{MC}" xmlns:p="{P}" xmlns:p14="{P14}" xmlns:p159="{P159}">
  <mc:Choice Requires="p159"><p:transition spd="slow" p14:dur="{duration}"><p159:morph option="byObject"/></p:transition></mc:Choice>
  <mc:Fallback><p:transition spd="med" p14:dur="450"><p:fade thruBlk="0"/></p:transition></mc:Fallback>
</mc:AlternateContent>'''


def timing_xml(entries):
    effects = []
    next_id = 5
    for shape_id, delay, duration in entries:
        effects.append(effect_xml(next_id, shape_id, delay, duration))
        next_id += 3
    return f'''<p:timing xmlns:p="{P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>{''.join(effects)}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn>
<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>
</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'''


def drawable_elements(root):
    tree = root.find("p:cSld/p:spTree", NS)
    allowed = {f"{{{P}}}sp", f"{{{P}}}pic", f"{{{P}}}graphicFrame", f"{{{P}}}grpSp", f"{{{P}}}cxnSp"}
    return [element for element in list(tree) if element.tag in allowed]


def animate_slide(data, page, index):
    root = ET.fromstring(data)
    elements = drawable_elements(root)
    paired = set()
    for marker in page["motion"]:
        element = elements[marker["element_index"]]
        properties = element.find(".//p:cNvPr", NS)
        properties.set("name", marker["name"])
        paired.add(properties.get("id"))
    entries = []
    for order, element_index in enumerate(page["fade"]):
        element = elements[element_index]
        shape_id = element.find(".//p:cNvPr", NS).get("id")
        if shape_id not in paired:
            entries.append((shape_id, 100 + order * 55, 320))
    if index > 1:
        root.append(ET.fromstring(transition_xml()))
    if entries:
        root.append(ET.fromstring(timing_xml(entries)))
    return ET.tostring(root, encoding="UTF-8", xml_declaration=True), len(entries)


def command_animate(args):
    started = time.perf_counter()
    source = Path(args.base).resolve()
    output = Path(args.output).resolve()
    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    counts = {}
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for item in archive.infolist():
            data = archive.read(item.filename)
            match = re.match(r"ppt/slides/slide(\d+)\.xml$", item.filename)
            if match:
                index = int(match.group(1))
                data, counts[index] = animate_slide(data, job["pages"][index - 1], index)
            target.writestr(item, data)
    write_seconds = time.perf_counter() - started
    verify_started = time.perf_counter()
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        for index, page in enumerate(job["pages"], 1):
            root = ET.fromstring(archive.read(f"ppt/slides/slide{index}.xml"))
            names = [node.get("name") for node in root.findall(".//p:cNvPr", NS)]
            for marker in page["motion"]:
                assert marker["name"] in names
            shape_ids = {node.get("id") for node in root.findall(".//p:cNvPr", NS)}
            assert all(node.get("spid") in shape_ids for node in root.findall(".//p:spTgt", NS))
            morphs = root.findall(".//p159:morph", NS)
            assert len(morphs) == (1 if index > 1 else 0)
            assert not root.findall(".//p14:morph", NS)
    result = {"write_seconds": round(write_seconds, 6), "verify_seconds": round(time.perf_counter() - verify_started, 6),
              "fade_count": sum(counts.values()), "morph_count": len(job["pages"]) - 1, "output": str(output)}
    write_json(job_path.parent / "animation-timings.json", result)
    print(json.dumps(result, ensure_ascii=False))


def command_audit(args):
    started = time.perf_counter()
    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    model = json.loads((job_path.parent / job["content_file"]).read_text(encoding="utf-8"))
    with zipfile.ZipFile(args.pptx) as archive:
        slide_names = sorted([name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)], key=slide_number)
        slide_texts = []
        for name in slide_names:
            root = ET.fromstring(archive.read(name))
            slide_texts.append(clean(" ".join(node.text or "" for node in root.findall(".//a:t", NS))))
    all_text = clean(" ".join(slide_texts))
    missing = []
    for item in model["blocks"]:
        if clean(item["text"]) not in all_text:
            missing.append({"id": item["id"], "text": item["text"], "source": item["source"]})
    result = {"source_blocks": len(model["blocks"]), "matched_blocks": len(model["blocks"]) - len(missing),
              "missing_blocks": missing, "slides": len(slide_names), "seconds": round(time.perf_counter() - started, 6)}
    write_json(job_path.parent / "fidelity-audit.json", result)
    print(json.dumps(result, ensure_ascii=False))
    if missing:
        raise SystemExit(2)


def xml_text(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def color_xml(value):
    value = value.lstrip("#")
    rgb = value[:6].upper()
    alpha = value[6:8] if len(value) == 8 else "FF"
    if alpha == "00":
        return "<a:noFill/>"
    alpha_xml = "" if alpha == "FF" else f'<a:alpha val="{round(int(alpha, 16) / 255 * 100000)}"/>'
    return f'<a:solidFill><a:srgbClr val="{rgb}">{alpha_xml}</a:srgbClr></a:solidFill>'


def xfrm_xml(element):
    x, y, w, h = [round(element[key] * 9525) for key in ("x", "y", "w", "h")]
    return f'<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{max(1, w)}" cy="{max(1, h)}"/></a:xfrm>'


def shape_xml(element, shape_id, name):
    geometry = element.get("shape", "rect")
    fill = color_xml(element.get("fill", "#00000000"))
    stroke = element.get("stroke")
    if stroke:
        line = f'<a:ln w="{round(stroke.get("widthPt", 1) * 12700)}">{color_xml(stroke["color"])}</a:ln>'
    else:
        line = "<a:ln><a:noFill/></a:ln>"
    return f'''<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="{xml_text(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr>{xfrm_xml(element)}<a:prstGeom prst="{geometry}"><a:avLst/></a:prstGeom>{fill}{line}</p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>'''


def paragraph_xml(paragraph):
    align = {"left": "l", "center": "ctr", "right": "r", "justify": "just"}.get(paragraph.get("align", "left"), "l")
    spacing = round(paragraph.get("lineSpacingPct", 110) * 1000)
    after = round(paragraph.get("spaceAfterPt", 0) * 100)
    runs = []
    for run in paragraph.get("runs", []):
        size = round(run.get("sizePt", 16) * 100)
        bold = ' b="1"' if run.get("bold") else ""
        italic = ' i="1"' if run.get("italic") else ""
        font = xml_text(run.get("font", FONT))
        runs.append(f'''<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="{size}"{bold}{italic} dirty="0">{color_xml(run.get("color", THEME["ink"]))}<a:latin typeface="{font}"/><a:ea typeface="{font}"/><a:cs typeface="{font}"/></a:rPr><a:t>{xml_text(run.get("text", ""))}</a:t></a:r>''')
    return f'''<a:p><a:pPr algn="{align}"><a:lnSpc><a:spcPct val="{spacing}"/></a:lnSpc><a:spcAft><a:spcPts val="{after}"/></a:spcAft></a:pPr>{''.join(runs)}</a:p>'''


def text_xml(element, shape_id, name):
    paragraphs = "".join(paragraph_xml(paragraph) for paragraph in element.get("paragraphs", []))
    return f'''<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="{xml_text(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr>{xfrm_xml(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
<p:txBody><a:bodyPr wrap="square" rtlCol="0" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>'''


def picture_xml(element, shape_id, name, relationship_id):
    alt = xml_text(element.get("alt", ""))
    return f'''<p:pic><p:nvPicPr><p:cNvPr id="{shape_id}" name="{xml_text(name)}" descr="{alt}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="{relationship_id}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm_xml(element)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'''


def slide_xml(page_job):
    page = page_job["page"]
    names = {marker["element_index"]: marker["name"] for marker in page_job["motion"]}
    shapes = []
    picture_count = 0
    for index, element in enumerate(page["elements"]):
        shape_id = index + 2
        name = names.get(index, f"Element {shape_id}")
        if element["type"] == "shape":
            shapes.append(shape_xml(element, shape_id, name))
        elif element["type"] == "text":
            shapes.append(text_xml(element, shape_id, name))
        elif element["type"] == "image":
            picture_count += 1
            shapes.append(picture_xml(element, shape_id, name, f"rId{picture_count + 1}"))
        else:
            raise ValueError("本地渲染器仅接受文字、形状和 PNG/JPEG 图片")
    background = page.get("background", THEME["background"]).lstrip("#")[:6].upper()
    data = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}" xmlns:mc="{MC}" xmlns:p14="{P14}" xmlns:p159="{P159}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="{background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{''.join(shapes)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'''.encode("utf-8")
    animated, fade_count = animate_slide(data, page_job, page_job["number"])
    return animated, fade_count


def render_package(job, shell, output):
    pages = job["pages"]
    presentation_rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>']
    slide_ids = []
    fade_count = 0
    for index in range(1, len(pages) + 1):
        presentation_rels.append(f'<Relationship Id="rId{index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{index}.xml"/>')
        slide_ids.append(f'<p:sldId id="{255 + index}" r:id="rId{index + 1}"/>')
    presentation = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{''.join(slide_ids)}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'''
    rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{''.join(presentation_rels)}</Relationships>'''
    with zipfile.ZipFile(shell) as source:
        content_types = source.read("[Content_Types].xml").decode("utf-8")
        content_types = re.sub(r'<Override PartName="/ppt/slides/slide\d+\.xml"[^>]*/>', "", content_types)
        overrides = "".join(f'<Override PartName="/ppt/slides/slide{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' for index in range(1, len(pages) + 1))
        image_defaults = "".join(f'<Default Extension="{extension}" ContentType="{mime}"/>'
                                 for extension, mime in [("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg")]
                                 if not re.search(f'Extension="{extension}"', content_types, re.I))
        content_types = content_types.replace("</Types>", image_defaults + overrides + "</Types>")
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
            for item in source.infolist():
                name = item.filename
                if re.match(r"ppt/slides/slide\d+\.xml$", name) or re.match(r"ppt/slides/_rels/slide\d+\.xml\.rels$", name):
                    continue
                if name in {"ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "[Content_Types].xml"}:
                    continue
                target.writestr(item, source.read(name))
            target.writestr("ppt/presentation.xml", presentation)
            target.writestr("ppt/_rels/presentation.xml.rels", rels)
            target.writestr("[Content_Types].xml", content_types)
            for page in pages:
                index = page["number"]
                data, count = slide_xml(page)
                fade_count += count
                target.writestr(f"ppt/slides/slide{index}.xml", data)
                relationships = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>']
                pictures = [element for element in page["page"]["elements"] if element["type"] == "image"]
                for picture_index, element in enumerate(pictures, 2):
                    source_path = Path(element["path"])
                    extension = image_extension(source_path.read_bytes()[:16])
                    media_name = f"slide{index}-image{picture_index - 1}{extension}"
                    target.writestr(f"ppt/media/{media_name}", source_path.read_bytes())
                    relationships.append(f'<Relationship Id="rId{picture_index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{media_name}"/>')
                page_rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{''.join(relationships)}</Relationships>'''
                target.writestr(f"ppt/slides/_rels/slide{index}.xml.rels", page_rels)
    return fade_count


def command_render(args):
    started = time.perf_counter()
    job_path = Path(args.job).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    output = Path(args.output).resolve()
    shell = Path(__file__).resolve().parent / "assets" / "base.pptx"
    fade_count = render_package(job, shell, output)
    write_seconds = time.perf_counter() - started
    verify_started = time.perf_counter()
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert len([name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)]) == len(job["pages"])
        for page in job["pages"]:
            root = ET.fromstring(archive.read(f"ppt/slides/slide{page['number']}.xml"))
            assert len(drawable_elements(root)) == len(page["page"]["elements"])
            assert len(root.findall(".//p159:morph", NS)) == (1 if page["number"] > 1 else 0)
            assert not root.findall(".//p14:morph", NS)
            assert all(fade.get("thruBlk") == "0" for fade in root.findall(".//p:fade", NS))
    result = {"write_seconds": round(write_seconds, 6), "verify_seconds": round(time.perf_counter() - verify_started, 6),
              "total_seconds": round(time.perf_counter() - started, 6), "pages": len(job["pages"]),
              "fade_count": fade_count, "morph_count": len(job["pages"]) - 1, "output": str(output)}
    write_json(job_path.parent / "render-timings.json", result)
    print(json.dumps(result, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="无第三方依赖的 PPT 内容解析、规划、动画与保真校验原型")
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan = subparsers.add_parser("plan")
    plan.add_argument("input")
    plan.add_argument("--out", required=True)
    plan.add_argument("--style", choices=sorted(THEMES), default="paper")
    plan.set_defaults(func=command_plan)
    render = subparsers.add_parser("render")
    render.add_argument("job")
    render.add_argument("--output", required=True)
    render.set_defaults(func=command_render)
    animate = subparsers.add_parser("animate")
    animate.add_argument("base")
    animate.add_argument("job")
    animate.add_argument("--output", required=True)
    animate.set_defaults(func=command_animate)
    audit = subparsers.add_parser("audit")
    audit.add_argument("job")
    audit.add_argument("pptx")
    audit.set_defaults(func=command_audit)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
