# Erzeugt docs/DEMO_LEITFADEN.pdf aus docs/DEMO_LEITFADEN.md (benötigt: pip install reportlab, Windows-Schriften)
import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer,
                                Table, TableStyle)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'docs', 'DEMO_LEITFADEN.md')
OUT = os.path.join(ROOT, 'docs', 'DEMO_LEITFADEN.pdf')
FONTS = os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts')

pdfmetrics.registerFont(TTFont('UI', os.path.join(FONTS, 'segoeui.ttf')))
pdfmetrics.registerFont(TTFont('UI-Bold', os.path.join(FONTS, 'segoeuib.ttf')))
pdfmetrics.registerFont(TTFont('Mono', os.path.join(FONTS, 'consola.ttf')))
pdfmetrics.registerFont(TTFont('Sym', os.path.join(FONTS, 'seguisym.ttf')))

INK = colors.HexColor('#15202b')
ACCENT = colors.HexColor('#0b4f8a')
MUTED = colors.HexColor('#5a6875')
LINE = colors.HexColor('#c9d2da')
SOFT = colors.HexColor('#eef3f8')

base = ParagraphStyle('base', fontName='UI', fontSize=10, leading=14.5, textColor=INK, alignment=TA_LEFT)
S = {
    'p': base,
    'h1': ParagraphStyle('h1', parent=base, fontName='UI-Bold', fontSize=22, leading=27, textColor=ACCENT, spaceAfter=4),
    'h2': ParagraphStyle('h2', parent=base, fontName='UI-Bold', fontSize=13.5, leading=18, textColor=ACCENT, spaceBefore=12, spaceAfter=5),
    'li': ParagraphStyle('li', parent=base, spaceAfter=3.5),
    'cell': ParagraphStyle('cell', parent=base, fontSize=9.5, leading=13),
    'cellh': ParagraphStyle('cellh', parent=base, fontName='UI-Bold', fontSize=9.5, leading=13),
}

LABELS = {'Klicken': '#0b4f8a', 'Klicken (optional)': '#0b4f8a', 'Zeigt sich': '#1d7a4c', 'Sagen': '#a15c00'}


def esc(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def inline(text):
    """Markdown-Auszeichnung (fett, Code) in ReportLab-Markup umsetzen"""
    out = []
    for part in re.split(r'(`[^`]+`)', text):
        if part.startswith('`') and part.endswith('`') and len(part) > 2:
            out.append(f'<font name="Mono" backColor="#eef3f8">&nbsp;{esc(part[1:-1])}&nbsp;</font>')
            continue
        t = esc(part)

        def bold(m):
            label = m.group(1)
            key = label.rstrip(':')
            if key in LABELS:
                return f'<font name="UI-Bold" color="{LABELS[key]}">{label}</font>'
            return f'<font name="UI-Bold">{label}</font>'

        t = re.sub(r'\*\*(.+?)\*\*', bold, t)
        t = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<i>\1</i>', t)
        out.append(t)
    s = ''.join(out)
    # Zeichen, die Segoe UI nicht enthält, aus der Symbolschrift nehmen
    return re.sub(r'([✓▶→])', r'<font name="Sym">\1</font>', s)


def build():
    lines = open(SRC, encoding='utf-8').read().split('\n')
    story = []
    i = 0
    section = []  # Überschrift mit erstem Inhalt zusammenhalten

    def flush_section():
        nonlocal section
        if section:
            story.append(KeepTogether(section[:3]))
            story.extend(section[3:])
            section = []

    def add(f):
        (section if section else story).append(f)

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith('# '):
            story.append(Paragraph(inline(line[2:]), S['h1']))
            story.append(HRFlowable(width='100%', thickness=1.2, color=ACCENT, spaceAfter=8))
            i += 1
        elif line.startswith('## '):
            flush_section()
            section = [Paragraph(inline(line[3:]), S['h2'])]
            i += 1
        elif line.startswith('- '):
            items = []
            while i < len(lines) and lines[i].startswith('- '):
                items.append(ListItem(Paragraph(inline(lines[i][2:]), S['li']), leftIndent=12, bulletColor=MUTED))
                i += 1
            add(ListFlowable(items, bulletType='bullet', start='•', bulletFontName='UI', bulletFontSize=9, leftIndent=12))
        elif line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                    rows.append(cells)
                i += 1
            ncol = len(rows[0])
            data = [[Paragraph(inline(c), S['cellh'] if r == 0 else S['cell']) for c in row] for r, row in enumerate(rows)]
            width = 170 * mm
            if ncol == 3:
                widths = [14 * mm, width - 14 * mm - 24 * mm, 24 * mm]
            else:
                widths = [width * 0.42, width * 0.58]
            t = Table(data, colWidths=widths, repeatRows=1)
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), SOFT),
                ('LINEBELOW', (0, 0), (-1, -1), 0.5, LINE),
                ('LINEABOVE', (0, 0), (-1, 0), 0.5, LINE),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ]))
            add(t)
            add(Spacer(1, 4))
        else:
            add(Paragraph(inline(line), S['p']))
            add(Spacer(1, 5))
            i += 1
    flush_section()

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont('UI', 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(20 * mm, 11 * mm, 'Projektversand – Demo-Leitfaden')
        canvas.drawRightString(A4[0] - 20 * mm, 11 * mm, f'Seite {doc.page}')
        canvas.restoreState()

    doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=18 * mm,
                            title='Demo-Leitfaden Projektversand', author='Projektversand', subject='Sprechzettel für die Präsentation')
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return OUT


if __name__ == '__main__':
    sys.stdout.write(build() + '\n')
