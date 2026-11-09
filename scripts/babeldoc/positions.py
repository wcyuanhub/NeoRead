"""Verified glyph positions; never infer a sentence from page-wide fuzzy text."""
import math
import unicodedata


def normalize(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


def paragraph_characters(paragraph):
    for item in paragraph.pdf_paragraph_composition:
        if item.pdf_character:
            yield item.pdf_character
        for field in ('pdf_formula', 'pdf_line', 'pdf_same_style_characters'):
            group = getattr(item, field, None)
            if group:
                yield from group.pdf_character


def sentence_slices(glyphs, targets):
    """Whole fragment must agree; repeated sentences split in recorded order."""
    value = ''.join(normalize(g['text']) for g in glyphs)
    needles = [normalize(t) for t in targets]
    if any(not n for n in needles) or value != ''.join(needles):
        return None
    result, start, offset = [], 0, 0
    for i, needle in enumerate(needles):
        end_offset = offset + len(needle)
        end, current = start, offset
        while end < len(glyphs) and current < end_offset:
            current += len(normalize(glyphs[end]['text']))
            end += 1
        if current != end_offset:
            return None  # a ligature crossing sentence boundaries is ambiguous
        while end < len(glyphs) and not normalize(glyphs[end]['text']):
            end += 1
        if i + 1 < len(targets):
            # Opening quotes/brackets belong to the next saved sentence.
            # Match that prefix backwards inside the punctuation boundary;
            # never attach it to the preceding sentence merely for being non-alphanumeric.
            prefix = ''
            for c in unicodedata.normalize('NFKC', targets[i+1]).casefold():
                if c.isalnum():
                    break
                if not c.isspace():
                    prefix += c
            if prefix:
                cursor, tail = end, ''
                while cursor > start and not normalize(glyphs[cursor-1]['text']):
                    cursor -= 1
                    tail = ''.join(c for c in unicodedata.normalize('NFKC', glyphs[cursor]['text']).casefold() if not c.isspace()) + tail
                    if tail == prefix:
                        end = cursor
                        break
                else:
                    return None
        result.append(glyphs[start:end])
        start, offset = end, end_offset
    return result


def build_positions(snapshot, records, pdf_path, clean):
    import pymupdf
    blocks = {b['id']: b for b in snapshot['blocks']}
    collected = {key: {} for key in blocks}
    with pymupdf.open(pdf_path) as pdf:
        pages = []
        for page in pdf:
            glyphs, bins = [], {}
            # IL boxes and rawdict are unrotated. Do not publish coordinates
            # in a different display space without a verified transform.
            if page.rotation or page.cropbox != page.mediabox:
                pages.append((page.rect.width, page.rect.height, bins))
                continue
            for block in page.get_text('rawdict')['blocks']:
                for line in block.get('lines', []):
                    # Unsupported rotation goes to the full translation panel.
                    if abs(line['dir'][1]) > .01 or line['dir'][0] < .99:
                        continue
                    for span in line['spans']:
                        for char in span['chars']:
                            x, y, x2, y2 = char['bbox']
                            entry = {'text': char['c'], 'rect': (x, y, x2, y2), 'id':len(glyphs)}
                            glyphs.append(entry)
                            bins.setdefault((int((x+x2)/32), int((y+y2)/32)), []).append(entry)
            pages.append((page.rect.width, page.rect.height, bins))
        consumed = set()
        for paragraph, page_number, key in records:
            block_id, first, last = key
            block = blocks[block_id]
            width, height, bins = pages[page_number-1]
            actual, pending = [], set()
            valid = True
            for char in paragraph_characters(paragraph):
                if not char.char_unicode:
                    continue
                box = char.box
                expected = (box.x, height-box.y2, box.x2, height-box.y)
                if char.char_unicode.isspace():
                    x,y,x2,y2=expected
                    if 0<=x<x2<=width and 0<=y<y2<=height:
                        actual.append({'text':' ','bounds':{'x':x/width,'y':y/height,'width':(x2-x)/width,'height':(y2-y)/height}})
                    continue
                cx, cy = (expected[0]+expected[2])/2, (expected[1]+expected[3])/2
                candidates = []
                radius = max(1, math.ceil((box.y2-box.y)/16))
                for dx in range(-radius,radius+1):
                    for dy in range(-radius,radius+1):
                        for g in bins.get((int(cx/16)+dx, int(cy/16)+dy), []):
                            if (page_number,g['id']) in consumed or g['id'] in pending:
                                continue
                            if unicodedata.normalize('NFKC',g['text']) != unicodedata.normalize('NFKC',char.char_unicode):
                                continue
                            x,y,x2,y2 = g['rect']
                            if abs((x+x2)/2-cx) > max(1.5,(box.x2-box.x)*.35) or abs((y+y2)/2-cy) > max(2,box.y2-box.y):
                                continue
                            candidates.append((abs((x+x2)/2-cx)+abs((y+y2)/2-cy),g))
                if not candidates:
                    valid = False
                    break
                candidates.sort(key=lambda v:v[0])
                g = candidates[0][1]
                pending.add(g['id'])
                x,y,x2,y2 = g['rect']
                if not (all(math.isfinite(v) for v in (x,y,x2,y2)) and 0 <= x < x2 <= width+.1 and 0 <= y < y2 <= height+.1):
                    valid = False
                    break
                actual.append({'text':g['text'],'bounds':{'x':x/width,'y':y/height,'width':(x2-x)/width,'height':(y2-y)/height}})
            targets = [clean(s['target']) for s in block['sentences'][first:last+1]]
            slices = sentence_slices(actual, targets) if valid else None
            if slices is None:
                continue
            consumed.update((page_number,i) for i in pending)
            for index, glyphs in enumerate(slices,first):
                if index in collected[block_id]:
                    collected[block_id][index] = None
                else:
                    collected[block_id][index] = {'index':index,'glyphs':glyphs}
    result = []
    for block_id, block in blocks.items():
        sentences = collected[block_id]
        complete = len(sentences)==len(block['sentences']) and all(sentences.values())
        result.append({'blockId':block_id,'sourceHash':block['sourceHash'],
                       'targets':[s['target'] for s in block['sentences']], 'page':block['page'],
                       'status':'mapped' if complete else 'fallback',
                       'reason':'' if complete else 'unverified_positions',
                       'sentences':[sentences[i] for i in range(len(sentences))] if complete else []})
    return {'version':1,'blocks':result}
