"""聊天截图的文字行与气泡重建，只调用 MinerU 内置模型。"""

from collections import deque
import re
import numpy as np
from PIL import Image


def analyze_chat(image, filename, model, mode="auto"):
    """输出原图坐标，自动模式仅接管有左右聊天气泡的布局。"""
    original_width, original_height = image.size
    scale = original_width / 900
    normalized = image.resize((900, max(1, round(original_height / scale)))) if original_width != 900 else image
    regions = bubble_regions(normalized)
    candidate = len(regions) >= 2 and any(region["side"] == "right" for region in regions)
    if mode != "chat" and not candidate:
        return None
    lines, tiles = ocr_lines(model, normalized, regions, tiled=normalized.height > 2000)
    result = reconstruct(normalized, filename, lines, regions)
    result["tiles"] = tiles
    # 每处引用都产生独立坐标列表，避免相同对象被重复缩放。
    for item in result["messages"]:
        item["bbox"] = [round(value * scale, 2) for value in item["bbox"]]
        for field in ["time_source", "name_source"]:
            if item.get(field):
                item[field]["bbox"] = [round(value * scale, 2) for value in item[field]["bbox"]]
    for line in lines:
        line["bbox"] = [round(value * scale, 2) for value in line["bbox"]]
    result["image_size"] = [original_width, original_height]
    return result

def compact(text):
    return re.sub(r"\s+", "", text)

def bubble_regions(image):
    """按浅色主题白色/绿色气泡连通区域定位，未知布局交给审核。"""
    scale = 3
    pixels = np.asarray(image.convert("RGB"))[::scale, ::scale].astype(np.int16)
    green = (pixels[:, :, 1] > 160) & (pixels[:, :, 1] - pixels[:, :, 0] > 30) & (pixels[:, :, 1] - pixels[:, :, 2] > 30)
    white = np.min(pixels, axis=2) > 248
    mask = green | white
    mask[:int(95 / scale), :] = False
    mask[:, :int(100 / scale)] = False
    mask[:, int((image.width - 100) / scale):] = False
    height, width = mask.shape
    regions = []
    for y, x in zip(*np.nonzero(mask)):
        if not mask[y, x]:
            continue
        queue = deque([(y, x)])
        mask[y, x] = False
        xs, ys = [], []
        green_count = 0
        while queue:
            cy, cx = queue.popleft()
            xs.append(cx)
            ys.append(cy)
            green_count += int(green[cy, cx])
            for ny, nx in [(cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)]:
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx]:
                    mask[ny, nx] = False
                    queue.append((ny, nx))
        bbox = [int(min(xs) * scale), int(min(ys) * scale), int((max(xs) + 1) * scale), int((max(ys) + 1) * scale)]
        if bbox[2] - bbox[0] >= 65 and bbox[3] - bbox[1] >= 45 and len(xs) > 160:
            regions.append({"bbox": bbox, "side": "right" if green_count / len(xs) > 0.5 else "left"})
    return sorted(regions, key=lambda item: item["bbox"][1])

def image_tiles(image, regions, max_height=1500):
    """长截图分片时沿气泡之间的空隙裁切，坐标恢复到原图。"""
    start = 0
    while start < image.height:
        end = min(start + max_height, image.height)
        for region in regions:
            y1, y2 = region["bbox"][1], region["bbox"][3]
            if y1 < end < y2:
                end = max(start + 1, y1 - 5)
                break
        if end - start < 200 and end != image.height:
            raise ValueError("单个消息区域过高，需要人工确认裁切边界")
        yield start, image.crop((0, start, image.width, end))
        start = end

def ocr_lines(model, image, regions, tiled):
    from docvortex.image import decode_image
    import io
    tiles = image_tiles(image, regions) if tiled else [(0, image)]
    lines, tile_count = [], 0
    for offset_y, tile in tiles:
        tile_count += 1
        buffer = io.BytesIO()
        tile.save(buffer, format="PNG")
        array = decode_image(buffer.getvalue(), color=True, apply_orientation=True)
        detected = model.ocr(array, tqdm_enable=False)[0] or []
        for polygon, (text, score) in detected:
            points = np.asarray(polygon)
            bbox = [float(points[:, 0].min()), float(points[:, 1].min()) + offset_y,
                    float(points[:, 0].max()), float(points[:, 1].max()) + offset_y]
            lines.append({"text": text, "score": float(score), "bbox": bbox, "tile": tile_count - 1})
    return sorted(lines, key=lambda line: (line["bbox"][1], line["bbox"][0])), tile_count

TIME_PATTERN = re.compile(r"^(?:(\d{4}年\d{1,2}月\d{1,2}日))?(\d{1,2}[:：]\d{2})$")

def reconstruct(image, filename, lines, regions):
    header = [line for line in lines if line["bbox"][3] < 90 and line["bbox"][0] > image.width * .2]
    title = compact("".join(line["text"] for line in header))
    group = bool(re.search(r"[（(]\d+[）)]$", title))
    outside = []
    messages = []
    used = set()
    for region in regions:
        x1, y1, x2, y2 = region["bbox"]
        members = []
        for index, line in enumerate(lines):
            lx1, ly1, lx2, ly2 = line["bbox"]
            cx, cy = (lx1 + lx2) / 2, (ly1 + ly2) / 2
            if x1 <= cx <= x2 and y1 <= cy <= y2:
                used.add(index)
                members.append(line)
        messages.append({"side": region["side"], "text": "\n".join(line["text"] for line in members),
                         "bbox": region["bbox"], "source": filename,
                         "text_lines": members, "display_name": None, "time_context": None,
                         "time_source": None, "warnings": []})
    for index, line in enumerate(lines):
        if index not in used and line["bbox"][1] >= 90:
            outside.append(line)
    timestamps = [line for line in outside if TIME_PATTERN.fullmatch(compact(line["text"]))]
    timestamp_ids = {id(line) for line in timestamps}
    names = [line for line in outside if id(line) not in timestamp_ids]
    assigned_names = set()
    for index, item in enumerate(messages):
        y = item["bbox"][1]
        prior_times = [line for line in timestamps if line["bbox"][3] <= y]
        if prior_times:
            latest = max(prior_times, key=lambda line: line["bbox"][1])
            item["time_context"] = compact(latest["text"])
            item["time_source"] = {"file": filename, "bbox": latest["bbox"], "kind": "visible_separator_context"}
        if item["side"] == "right":
            item["sender"] = "self_side"
        elif group:
            candidates = [line for line in names if 0 <= y - line["bbox"][3] < 65
                          and abs(line["bbox"][0] - item["bbox"][0]) < 55]
            if len(candidates) == 1:
                line = candidates[0]
                item["display_name"] = compact(line["text"])
                item["sender"] = f"display_name:{item['display_name']}"
                item["name_source"] = {"file": filename, "bbox": line["bbox"]}
                assigned_names.add(id(line))
            else:
                item["sender"] = "unknown_member"
                item["warnings"].append("群成员昵称无法唯一确认")
        else:
            item["sender"] = "counterpart_side"
            item["display_name"] = title or None
        if not item["text"].strip():
            item["warnings"].append("气泡内未识别到文字，需审核")
        if any(line["score"] < .85 for line in item["text_lines"]):
            item["warnings"].append("部分文字识别分数偏低，需审核")
        item["sequence"] = index + 1
        item["identity_verified"] = False
        item["status"] = "manual_review" if item["warnings"] else "reconstructed"
    unmatched = [line for line in names if id(line) not in assigned_names]
    warnings = ["存在未归属文字，需要审核"] if unmatched else []
    if not messages:
        warnings.append("未定位到支持的聊天气泡，需要人工审核")
    if not title:
        warnings.append("聊天标题缺失，需要确认会话归属")
    return {"source": filename, "title": title, "group": group, "messages": messages,
            "unassigned_text": unmatched, "identity_verified": False,
            "warnings": warnings, "status": "manual_review" if warnings or any(item["warnings"] for item in messages) else "reconstructed"}
