"""生成真实合成附件及独立字段标注；只依赖环境内置 Pillow/reportlab。"""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('--font', default='C:/Windows/Fonts/simhei.ttf')
args = parser.parse_args()
pdfmetrics.registerFont(TTFont('BenchmarkChinese', args.font))
font = ImageFont.truetype(args.font, 32)

contract = ['购销合同', '付款方：甲电子公司；收款方：乙贸易公司。', '合同金额128000元；签订日期2026年9月1日。', '付款期限为2026年10月15日。']
receipt = ['银行转账回单', '付款方：甲电子公司；收款方：乙贸易公司。', '交易日期2026年10月12日；转账金额64000元。', '交易状态：成功；用途：货款。']
negative = ['双方对账确认书', '截至2026年11月1日，甲电子公司尚未支付尾款64000元。', '双方确认尚未付清，不存在现金支付记录。']
table = ['付款明细表', '日期                 金额           状态', '2026年10月12日      64000元        成功', '2026年10月13日      6400元         失败', '只有成功交易计入已付款，失败记录不计入。']
chat = ['聊天记录截图', '2026年10月12日 09:00 甲方：已转账64000元，请确认。', '2026年10月12日 09:05 乙方：已收到64000元。', '2026年10月13日 10:00 乙方：尾款尚未收到。']
manifest = []


def raster(lines, style='normal'):
    image = Image.new('RGB', (1400, 900), 'white')
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        draw.text((65, 90 + i * 85), line, font=font, fill=(155, 155, 155) if style == 'low_contrast' else 'black')
    if style == 'rotated':
        image = image.rotate(90, expand=True, fillcolor='white')
    if style == 'blurred':
        image = image.resize((350, 225)).resize((1400, 900)).filter(ImageFilter.GaussianBlur(2))
    return image


def record(file, kind, pages, fields, modes, **extra):
    claims = []
    for index, lines in enumerate(pages):
        body = '\n'.join(lines)
        if '购销合同' in body:
            claims.append({'text': '本合同金额为128000元。', 'relation': 'support', 'page': index + 1})
        if '银行转账回单' in body:
            claims.append({'text': '甲电子公司于2026年10月12日向乙贸易公司转账64000元，交易成功。', 'relation': 'support', 'page': index + 1})
            claims.append({'text': '本回单的转账金额为6400元。', 'relation': 'contradict', 'page': index + 1})
        if '双方对账确认书' in body:
            claims.append({'text': '截至2026年11月1日，甲电子公司已付清尾款64000元。', 'relation': 'contradict', 'page': index + 1})
        if '付款明细表' in body:
            claims.append({'text': '明细表中2026年10月13日的6400元交易成功。', 'relation': 'contradict', 'page': index + 1})
        if '聊天记录截图' in body:
            claims.append({'text': '乙方在2026年10月13日10:00表示尾款尚未收到。', 'relation': 'support', 'page': index + 1})
    if pages:
        claims.append({'text': '双方同意另行支付现金补偿金99999元。', 'relation': None, 'page': None})
    manifest.append({'id': file.stem, 'file': f'assets/{file.name}', 'kind': kind,
                     'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                     'pages': [{'text': '\n'.join(lines), 'fields': f, 'mode': mode} for lines, f, mode in zip(pages, fields, modes)],
                     'claims': claims, **extra})


def pdf(name, page_specs, kind):
    file = ASSETS / f'{name}.pdf'
    c = canvas.Canvas(str(file), pagesize=(700, 450), invariant=1)
    c.setTitle('LawVerify synthetic benchmark v2')
    pages, fields, modes = [], [], []
    for spec in page_specs:
        lines, f, mode = spec
        if mode == 'text':
            c.setFont('BenchmarkChinese', 16)
            for i, line in enumerate(lines):
                c.drawString(32, 395 - i * 42, line)
        elif mode == 'image':
            c.drawImage(ImageReader(raster(lines)), 0, 0, width=700, height=450)
        elif mode == 'mixed':
            c.setFont('BenchmarkChinese', 16)
            c.drawString(32, 410, lines[0])
            c.drawImage(ImageReader(raster(lines[1:])), 0, 0, width=700, height=360)
        pages.append(lines); fields.append(f); modes.append(mode)
        c.showPage()
    c.save()
    record(file, kind, pages, fields, modes)


contract_fields = ['甲电子公司', '乙贸易公司', '128000元', '2026年9月1日', '2026年10月15日']
receipt_fields = ['甲电子公司', '乙贸易公司', '2026年10月12日', '64000元', '成功']
negative_fields = ['2026年11月1日', '尚未支付尾款64000元', '不存在现金支付记录']
pdf('native-contract', [(contract, contract_fields, 'text')], 'native_pdf')
pdf('native-multipage', [(contract, contract_fields, 'text'), (receipt, receipt_fields, 'text'), (negative, negative_fields, 'text')], 'native_pdf')
pdf('scan-receipt', [(receipt, receipt_fields, 'image')], 'scan_pdf')
pdf('mixed-alternating', [(contract, contract_fields, 'text'), (receipt, receipt_fields, 'image'), (negative, negative_fields, 'text')], 'mixed_pdf')
pdf('mixed-same-page', [(['付款说明（文本层）'] + receipt, receipt_fields, 'mixed')], 'mixed_pdf')
pdf('scan-four-pages', [(contract, contract_fields, 'image'), (receipt, receipt_fields, 'image'), (table, ['64000元', '6400元', '失败'], 'image'), (negative, negative_fields, 'image')], 'scan_pdf')
for name, lines, fields, style in [
    ('receipt', receipt, receipt_fields, 'normal'),
    ('table', table, ['2026年10月12日', '64000元', '2026年10月13日', '6400元', '失败'], 'normal'),
    ('chat', chat, ['09:00', '09:05', '10:00', '已收到64000元', '尾款尚未收到'], 'normal'),
    ('rotated', negative, negative_fields, 'rotated'),
    ('low-contrast', receipt, receipt_fields, 'low_contrast'),
    ('blurred', negative, negative_fields, 'blurred'),
]:
    file = ASSETS / f'{name}.png'
    raster(lines, style).save(file)
    record(file, 'image_' + style, [lines], [fields], ['image'])

broken = ASSETS / 'corrupt.pdf'
broken.write_bytes(b'%PDF-1.4\nthis is a deliberately corrupt synthetic fixture\n')
record(broken, 'corrupt_pdf', [], [], [], expectFailure=True)
(ROOT / 'media-manifest.json').write_text(json.dumps({'corpus': 'synthetic-v2', 'font': Path(args.font).name,
    'annotation': '合成附件的明文事实标注；无隐含 OCR 文本层；非真实案件。', 'documents': manifest}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{len(manifest)} files generated in {ASSETS}')
