import { generateDeck } from './engine.js';

function friendlyError(error) {
  const message = String(error?.message || error || '生成失败');
  if (/无法连接|Failed to fetch|NetworkError/i.test(message)) {
    return '生成资源加载失败，请检查网络并刷新页面后重试。文件不会上传到服务器。';
  }
  if (/DecompressionStream|deflate-raw/i.test(message)) {
    return '当前浏览器不支持 Office 文件解压，请使用最新版 Chrome、Edge 或 Safari。';
  }
  if (/XML|parsererror|not well-formed|mismatched tag/i.test(message)) {
    return 'Office 文件内部结构无法读取，请在 WPS 中另存为新的 DOCX/PPTX 后重试。';
  }
  return message;
}

self.onmessage = async event => {
  if (event.data?.type !== 'generate') return;
  try {
    const { result, pptxBytes } = await generateDeck(event.data, stage => {
      self.postMessage({ type: 'stage', stage });
    });
    self.postMessage({ type: 'complete', result, pptx: pptxBytes.buffer }, [pptxBytes.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: friendlyError(error) });
  }
};
