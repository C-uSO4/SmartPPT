const test = require('node:test');
const assert = require('node:assert/strict');

async function loadModules() {
  const parser = await import('../src/web/engine/parser.js');
  const layout = await import('../src/web/engine/layout.js');
  return { parser, layout };
}

function sourceBlock(id, kind, text, slide, extra = {}) {
  return {
    id, kind, text, level: kind === 'heading' ? 2 : undefined,
    source: { slide, shape: 1, paragraph: 1 },
    top: 180, left: 80, width: 800, height: 100, font_size: 16,
    ...extra,
  };
}

function importedModel(makeModel) {
  const longValue = '1.8 ms @ +50；16 ms @ −20；恢复 4.7 ms @ −120';
  const asset = {
    name: 'curve.emf', bytes: new Uint8Array([1, 0, 0, 0]), width: 1600, height: 900,
    extension: '.emf', previewable: false,
  };
  const blocks = [
    sourceBlock('b0001', 'heading', '示例研究汇报', 1, { level: 1 }),
    sourceBlock('b0002', 'heading', '目录', 2),
    sourceBlock('b0003', 'paragraph', '1', 2, { top: 220, left: 90 }),
    sourceBlock('b0004', 'paragraph', '研究背景', 2, { top: 220, left: 180 }),
    sourceBlock('b0005', 'paragraph', '2', 2, { top: 300, left: 90 }),
    sourceBlock('b0006', 'paragraph', '研究内容', 2, { top: 300, left: 180 }),
    sourceBlock('b0007', 'paragraph', '3', 2, { top: 380, left: 90 }),
    sourceBlock('b0008', 'paragraph', '总结展望', 2, { top: 380, left: 180 }),
    sourceBlock('b0009', 'paragraph', '4', 2, { top: 460, left: 90 }),
    sourceBlock('b0010', 'paragraph', '参考文献', 2, { top: 460, left: 180 }),
    sourceBlock('b0011', 'heading', '1.1 研究背景', 3),
    sourceBlock('b0012', 'paragraph', '第一段保持原样。\n第二段不能自动变成编号要点。', 3, { top: 430 }),
    sourceBlock('b0021', 'paragraph', '实现了', 3, {
      top: 200, left: 40, width: 175, height: 68, font_size: 36,
    }),
    sourceBlock('b0022', 'paragraph', '• 第一条原有要点保持原样。 • 第二条只按已有符号分段。', 3, {
      top: 160, left: 220, width: 500, height: 140, font_size: 20,
    }),
    sourceBlock('b0013', 'heading', '2.4.1 乘积模型', 4),
    sourceBlock('b0014', 'table', '参数\n值\n来源', 4, {
      top: 388, left: 100, width: 514, height: 160,
      rows: [
        ['参数', '值', '来源'],
        ['激活 V½ / k', '−25 mV / 7.9 mV', 'Shibasaki 1987; Vandenberg 2012'],
        ['失活 V½ / k', '−60 mV / 20 mV', 'Vandenberg 2012（整流法）'],
        ['τm 锚点', '188 ms @ +20；2 s @ −20', 'Snyders & Chaudhary 1996'],
        ['τh 锚点', longValue, 'Spector et al. 1996'],
      ],
    }),
    sourceBlock('b0018', 'paragraph', '正文与右侧图片相交时必须自动收窄，并保留全部原文，不能藏在图片下面。', 4, {
      top: 130, left: 100, width: 700, height: 120, font_size: 20,
    }),
    sourceBlock('b0015', 'image', '模型曲线', 4, {
      top: 100, left: 660, width: 470, height: 600, asset, audit: false,
    }),
    sourceBlock('b0016', 'heading', '3 总结展望', 5),
    sourceBlock('b0019', 'paragraph', '汇报人：示例\n时间：2026.10', 5, {
      top: 400, left: 180, width: 500, height: 80,
    }),
    sourceBlock('b0020', 'image', '校园背景', 5, {
      top: 80, left: 40, width: 1100, height: 600, asset, audit: false,
    }),
    sourceBlock('b0017', 'heading', '4 参考文献', 6),
  ];
  return { model: makeModel('fixture.pptx', blocks), longValue, asset };
}

test('Markdown 清理行内格式且保留正文角色与真实标点', async () => {
  const { parser } = await loadModules();
  const source = '# **研究标题**\n\n**\n\n这是一段**完整**正文，包含 2 * 3 和 variable_name；[参考链接](https://example.com) 与 `code_span`。\n\n- ~~过期标记~~ **仍保留**文字\n';
  const { blocks } = await parser.parseDocument('inline.md', new TextEncoder().encode(source));
  assert.deepEqual(blocks.map(item => item.kind), ['heading', 'paragraph', 'bullet']);
  assert.equal(blocks[0].text, '研究标题');
  assert.equal(blocks[1].text, '这是一段完整正文，包含 2 * 3 和 variable_name；参考链接 与 code_span。');
  assert.equal(blocks[2].text, '过期标记 仍保留文字');
  assert.ok(blocks.every(item => !/(?:\*\*|__|~~|`)/.test(item.text)));
  assert.equal(parser.markdownInlineText('**'), '');
});

test('完整句子不会被文本规则或 PPTX 页面分组提升为标题', async () => {
  const { parser } = await loadModules();
  const { blocks } = await parser.parseDocument('sentences.txt', new TextEncoder().encode('一、这是完整解释。\n1、另一条完整说明。\n'));
  assert.ok(blocks.every(item => item.kind !== 'heading'));
  const source = [
    sourceBlock('p1', 'paragraph', '没有标题占位的封面正文。', 1),
    sourceBlock('p2', 'paragraph', '第二页普通正文不应变成小标题。', 2),
  ];
  const model = parser.makeModel('plain.pptx', source);
  assert.equal(model.title, 'plain');
  assert.equal(model.sections[0].title, '第 2 页');
  assert.equal(model.sections[0].items[0].kind, 'paragraph');
});

test('Markdown 多行备注与注释块不会混入幻灯片正文', async () => {
  const { parser } = await loadModules();
  const source = [
    '# 标题', '开场正文', '备注：第一行讲稿', '第二行**讲稿**',
    '## 第一章', '章节正文', '<!--', '多行注释', '-->',
    '### 小节', '小节正文', ':::notes', '讲稿块', ':::',
    '## 第二章', '第二章正文', '',
  ].join('\n');
  const { blocks, notes } = await parser.parseDocument('notes.md', new TextEncoder().encode(source));
  assert.deepEqual(blocks.map(item => item.text), [
    '标题', '开场正文', '第一章', '章节正文', '小节', '小节正文', '第二章', '第二章正文',
  ]);
  assert.deepEqual(notes.map(item => item.text), ['第一行讲稿', '第二行讲稿', '多行注释', '讲稿块']);
  await assert.rejects(
    parser.parseDocument('broken-notes.md', new TextEncoder().encode('# 标题\n::: notes\n未闭合讲稿')),
    /备注块缺少结束标记/,
  );
});

test('Markdown 分页不擅自增加目录且小标题与后续正文同页', async () => {
  const { parser, layout } = await loadModules();
  const source = [
    '# 汇报', '## 第一章', '第一章正文',
    '## 第二章', '第二点一', '第二点二', '### 小节标题', '小节正文', '第二点五',
    '## 第三章', '第三章正文',
  ].join('\n\n');
  const { blocks } = await parser.parseDocument('pages.md', new TextEncoder().encode(source));
  const model = parser.makeModel('pages.md', blocks);
  const pages = layout.planPages(model);
  assert.equal(pages.some(page => page.plan.kind === 'overview'), false);
  assert.deepEqual(pages.map(page => page.plan.title), ['汇报', '第一章', '第二章', '第二章（续）', '第三章']);
  const sectionPages = pages.filter(page => page.plan.title.startsWith('第二章'));
  assert.ok(sectionPages.every(page => page.plan.items.at(-1)?.kind !== 'heading'));
  const subheadingPage = sectionPages.find(page => page.plan.items.some(item => item.text === '小节标题'));
  assert.ok(subheadingPage.plan.items.some(item => item.text === '小节正文'));
  for (const page of sectionPages) {
    const sourceLines = page.plan.source_ids.map(id => blocks.find(block => block.id === id).source.line);
    assert.ok(Math.min(...sourceLines) >= 7 && Math.max(...sourceLines) <= 17);
  }
});

test('PPTX 主章节、完整小标题与原始正文段落保持边界', async () => {
  const { parser, layout } = await loadModules();
  const { model } = importedModel(parser.makeModel);
  assert.deepEqual(model.chapters.map(chapter => chapter.title), ['研究背景', '研究内容', '总结展望', '参考文献']);
  const pages = layout.planPages(model);
  assert.equal(pages.length, 6);
  assert.equal(pages[2].plan.title, '1.1 研究背景');
  const body = pages[2].page.elements.find(element => element.type === 'text'
    && element.paragraphs.some(paragraph => paragraph.runs.some(run => run.text.includes('第一段保持原样'))));
  assert.ok(body);
  assert.equal(body.paragraphs.length, 2);
  assert.ok(body.paragraphs.every(paragraph => paragraph.bullet === false));
  assert.equal(body.paragraphs[1].runs[0].text, '第二段不能自动变成编号要点。');
});

test('PPTX 正文使用 1.3 倍行距、可读字号并只按已有符号分段', async () => {
  const { parser, layout } = await loadModules();
  const { model } = importedModel(parser.makeModel);
  const page = layout.planPages(model)[2];
  const body = page.page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text.startsWith('• 第一条原有要点'));
  const label = page.page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === '实现了');
  assert.ok(body && label);
  assert.equal(body.paragraphs.length, 2);
  assert.equal(body.paragraphs[1].runs[0].text, '• 第二条只按已有符号分段。');
  assert.ok(body.paragraphs.every(paragraph => paragraph.bullet === false));
  assert.ok(body.paragraphs.every(paragraph => paragraph.lineSpacingPct === 130));
  assert.ok(body.paragraphs.every(paragraph => paragraph.spaceAfterPt === 0));
  assert.equal(body.paragraphs.map(paragraph => paragraph.runs[0].text).join(' '),
    '• 第一条原有要点保持原样。 • 第二条只按已有符号分段。');
  assert.ok(body.paragraphs[0].runs[0].sizePt >= 18.5,
    `正文字号 ${body.paragraphs[0].runs[0].sizePt} 应明显大于旧版缩放字号`);
  assert.equal(label.paragraphs[0].runs[0].sizePt, 28,
    '普通正文不能因为字号大、文字短就被压缩成小标题');
  assert.ok(label.y + label.h <= 650);
  assert.ok(body.y + body.h <= 650);
});

test('PPTX 单栏双长文本框利用左侧空白并预留 WPS 行高', async () => {
  const { parser, layout } = await loadModules();
  const blocks = [
    sourceBlock('b1000', 'heading', '密集正文测试', 1, { level: 1 }),
    sourceBlock('b1001', 'heading', '3.2 局限', 2, { level: 2 }),
    sourceBlock('b1002', 'paragraph', '• 乘积模型：独立门假设；无法表达开放态选择性失活；单一激活门 → 单指数去激活；无显式 I 态 → 状态依赖阻断受限。 • ORd：r 瞬时 → 无钩；无显式 I 态 → 无状态依赖阻断；xf/xs 是数学分量，不是物理状态。 • 五态：现象学模型；参数不唯一；状态拓扑不是唯一；三关闭态是最小模型，不是结构事实。 • 三者共同：无药物结合态；无 hERG 1a/1b 异构体/辅助亚基；无转运/trafficking；单通道/well-stirred；无细胞环境。', 2, {
      top: 128, left: 245, width: 971, height: 260,
    }),
    sourceBlock('b1003', 'paragraph', '• 参数来源混合：不同实验室、表达系统、温度；绝对时间常数不可直接比较。 • 激活 V½ 依赖 P1 时长；失活 V½ 依赖方法（整流法 −60、外推法 −84、三脉冲 −94，差 34 mV）。 • τm/τh是锚点插值：τm只有 2 个锚点、4 个参数 → 欠定；τh有 4 个锚点，但来自不同实验/温度。 • 没有独立训练/测试划分；验证以内部一致性和结构对比为主。', 2, {
      top: 417, left: 248, width: 955, height: 226,
    }),
  ];
  const model = parser.makeModel('dense.pptx', blocks);
  const page = layout.planPages(model).find(item => item.plan.title === '3.2 局限');
  const bodies = page.page.elements.filter(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text.startsWith('•'));
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].x <= 220 && bodies[1].x <= 220, '单栏正文应利用左侧无效空白');
  assert.ok(bodies.every(body => body.w >= 850), '加宽正文以减少长段落的不必要换行');
  assert.ok(bodies[1].y - (bodies[0].y + bodies[0].h) >= 16, '相邻长文本框必须保留真实渲染间隔');
  assert.ok(bodies.every(body => body.y + body.h <= 650));
  assert.ok(bodies.every(body => body.paragraphs.every(paragraph => paragraph.lineSpacingPct === 130)));
});

test('PPTX 表格长行获得更高行高且 EMF 图片留在原页', async () => {
  const { parser, layout } = await loadModules();
  const { model, longValue, asset } = importedModel(parser.makeModel);
  const page = layout.planPages(model)[3];
  assert.equal(page.plan.layout, 'imported');
  assert.equal(page.plan.source_slide, 4);
  const header = page.page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === '参数');
  const longCell = page.page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === longValue);
  assert.ok(header && longCell);
  assert.ok(longCell.h > header.h, `长单元格高度 ${longCell.h} 应大于表头 ${header.h}`);
  assert.ok(longCell.h >= 52, `长单元格高度 ${longCell.h} 应容纳四行文字`);
  assert.ok(longCell.y + longCell.h <= 650);
  const picture = page.page.elements.find(element => element.type === 'image');
  assert.ok(picture);
  assert.equal(picture.asset, asset);
  assert.equal(picture.asset.extension, '.emf');
  assert.equal(picture.asset.previewable, false);
});

test('PPTX 正文自动避让右侧图片且保留完整文字', async () => {
  const { parser, layout } = await loadModules();
  const { model } = importedModel(parser.makeModel);
  const page = layout.planPages(model)[3];
  const body = page.page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text.startsWith('正文与右侧图片相交时'));
  const picture = page.page.elements.find(element => element.type === 'image');
  assert.ok(body && picture);
  assert.ok(body.x + body.w <= picture.x - 12,
    `正文右缘 ${body.x + body.w} 应位于图片左缘 ${picture.x} 之前`);
  assert.equal(body.paragraphs[0].runs[0].text,
    '正文与右侧图片相交时必须自动收窄，并保留全部原文，不能藏在图片下面。');
  assert.ok(body.y + body.h <= 650);
});

test('PPTX 大幅背景图位于正文底层且不挤压文字', async () => {
  const { parser, layout } = await loadModules();
  const { model } = importedModel(parser.makeModel);
  const page = layout.planPages(model)[4];
  const pictureIndex = page.page.elements.findIndex(element => element.type === 'image' && element.alt === '校园背景');
  const bodyIndex = page.page.elements.findIndex(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === '汇报人：示例');
  assert.ok(pictureIndex >= 0 && bodyIndex >= 0);
  assert.ok(pictureIndex < bodyIndex, '背景图必须先于正文写入，避免覆盖文字');
  const body = page.page.elements[bodyIndex];
  assert.ok(body.w > 300, `正文宽度 ${body.w} 不应被背景图压缩`);
  assert.equal(body.paragraphs[1].runs[0].text, '时间：2026.10');
});

test('模板内容分配到真实页面槽位且保留背景预览', async () => {
  const { parser, layout } = await loadModules();
  const blocks = [
    { id: 'b0001', kind: 'heading', text: '模板测试', level: 1, source: { line: 1 }, numbers: [] },
    { id: 'b0002', kind: 'heading', text: '第一部分', level: 2, source: { line: 3 }, numbers: [] },
    { id: 'b0003', kind: 'paragraph', text: '正文保持原生可编辑。', level: 0, source: { line: 4 }, numbers: [] },
  ];
  const model = parser.makeModel('outline.md', blocks);
  const asset = { name: 'background.png', bytes: new Uint8Array([1]), width: 1600, height: 900, extension: '.png' };
  const visualTemplate = {
    fonts: { title: 'Template Title', body: 'Template Body' },
    colors: {},
    cover: {
      background: '#101820', image: asset, imageLuminance: 0.12,
      colors: { lt1: '#FFFFFF', dk1: '#102A43', accent1: '#FF6600', accent2: '#00A389' },
    },
    content: {
      background: '#F4F1E8', image: null, imageLuminance: null,
      colors: { lt1: '#FFFFFF', dk1: '#102A43', accent1: '#FF6600', accent2: '#00A389' },
      decorations: [
        { type: 'shape', shape: 'rect', x: 20, y: 20, w: 30, h: 30, fill: '#FF6600', templateShapeId: 'master-decoration' },
        { type: 'image', asset, x: 1080, y: 40, w: 120, h: 68, fit: 'fill', templateShapeId: 'layout-picture' },
      ],
    },
    candidates: [
      {
        slidePart: 'ppt/slides/slide1.xml', slideNumber: 1,
        title: { id: '2', kind: 'title', left: 100, top: 100, width: 900, height: 100, fontSize: 36, text: '封面示例' },
        bodySlots: [{ id: '3', kind: 'body', left: 100, top: 260, width: 800, height: 180, fontSize: 20, text: '封面正文示例' }],
        pictureSlots: [], tableSlots: [], contentTextIds: ['3'],
      },
      {
        slidePart: 'ppt/slides/slide2.xml', slideNumber: 2,
        title: { id: '7', kind: 'title', left: 70, top: 50, width: 1000, height: 80, fontSize: 30, text: '内容标题示例' },
        bodySlots: [{ id: '9', kind: 'body', left: 80, top: 180, width: 900, height: 300, fontSize: 22, text: '内容正文示例' }],
        pictureSlots: [], tableSlots: [], contentTextIds: ['9'],
      },
    ],
  };
  const pages = layout.planPages(model, 'paper', visualTemplate);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].plan.template.slidePart, 'ppt/slides/slide1.xml');
  assert.equal(pages[1].plan.template.slidePart, 'ppt/slides/slide2.xml');
  assert.equal(pages[1].plan.template.assignments[0].slot.id, '9');
  assert.deepEqual(pages[1].plan.template.fadeShapeIds, ['7', '9']);
  assert.equal(pages[0].page.elements[0].fill, '#101820');
  assert.equal(pages[0].page.elements[1].type, 'image');
  assert.equal(pages[0].page.elements[1].fit, 'fill');
  assert.equal(pages[0].page.elements[1].templateBackground, true);
  assert.ok(pages[0].fade.every(index => index > 1 && index < pages[0].page.elements.length));
  const coverTitle = pages[0].page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === '模板测试');
  assert.equal(coverTitle.paragraphs[0].runs[0].font, 'Template Title');
  assert.equal(coverTitle.paragraphs[0].runs[0].color, '#FFFFFF');
  const contentTitle = pages[1].page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === '第一部分');
  const body = pages[1].page.elements.find(element => element.type === 'text'
    && element.paragraphs[0]?.runs[0]?.text === '正文保持原生可编辑。');
  assert.equal(pages[1].page.background, '#F4F1E8');
  assert.equal(pages[1].page.elements[1].fill, '#FF6600');
  assert.equal(pages[1].page.elements[2].type, 'image');
  assert.equal(pages[1].page.elements[2].asset, asset);
  assert.ok(pages[1].page.elements.findIndex(element => element === contentTitle) > 2,
    '模板装饰应先于新标题和正文绘制');
  assert.equal(contentTitle.paragraphs[0].runs[0].font, 'Template Title');
  assert.equal(contentTitle.paragraphs[0].runs[0].color, '#102A43');
  assert.equal(body.paragraphs[0].runs[0].font, 'Template Body');
  assert.ok(pages.every(page => page.fade.every(index => Number.isInteger(index)
    && index >= 0 && index < page.page.elements.length)));
});
