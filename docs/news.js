document.addEventListener('DOMContentLoaded', async () => {
  const newsStrip = document.getElementById('latest-news-content');
  const newsList = document.getElementById('news-list');
  const errorDetails = [];

  console.log('News initialization started.');

  try {
    // 1. Fetch the list of markdown files (with cache busting)
    const response = await fetch(`news_index.json?t=${Date.now()}`);
    if (!response.ok) throw new Error(`news_index.json の取得に失敗しました (Status: ${response.status})`);

    const fileNames = await response.json();
    console.log('News index loaded:', fileNames);

    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      if (newsStrip) newsStrip.textContent = '現在、新しいお知らせはありません。';
      if (newsList) newsList.innerHTML = '<div style="text-align: center; padding: 4rem;"><p>お知らせはありません。</p></div>';
      return;
    }

    const announcements = [];

    // 2. Fetch and parse each markdown file
    for (const fileName of fileNames) {
      try {
        // Ensure path is relative to the root docs folder
        const fetchPath = fileName.startsWith('/') ? fileName.substring(1) : fileName;
        console.log(`Fetching: ${fetchPath}`);

        const res = await fetch(`${fetchPath}?t=${Date.now()}`);
        const absoluteUrl = new URL(res.url, window.location.origin).href;
        if (!res.ok) {
          const errorMsg = `${fetchPath} の取得に失敗しました (Status: ${res.status})<br><small>${absoluteUrl}</small>`;
          console.warn(errorMsg);
          errorDetails.push(errorMsg);
          continue;
        }

        const text = await res.text();
        const parsed = parseMarkdownWithFrontmatter(text);
        announcements.push(parsed);
      } catch (fileErr) {
        console.error(`Error processing ${fileName}:`, fileErr);
        errorDetails.push(`${fileName}: ${fileErr.message}`);
      }
    }

    // 3. Sort by date (descending)
    announcements.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;
      return (dateB || 0) - (dateA || 0);
    });

    // Update Top Page Strip
    if (newsStrip) {
      if (announcements.length > 0) {
        const latest = announcements[0];
        newsStrip.innerHTML = `
          <span class="news-date">${latest.date || ''}</span>
          <a href="news.html">${latest.title || 'No Title'}</a>
        `;
      } else {
        newsStrip.textContent = 'お知らせの読み込みを完了しましたが、有効なデータが見つかりませんでした。';
      }
    }

    // Update News Page List
    if (newsList) {
      if (announcements.length > 0) {
        newsList.innerHTML = announcements.map(news => `
          <div class="news-item">
            <div class="news-meta">
              <span class="news-date">${news.date || ''}</span>
              <span class="news-cat ${getCatClass(news.category)}">${news.category || 'その他'}</span>
            </div>
            <h3>${news.title || 'No Title'}</h3>
            <div class="news-md-content">${window.marked ? marked.parse(news.content || '') : news.content}</div>
          </div>
        `).join('');
      } else {
        let html = '<div style="text-align: center; padding: 4rem;"><p>お知らせが見つかりませんでした。</p>';
        if (errorDetails.length > 0) {
          html += `<div class="debug-error-box">
            <p><strong>デバッグ情報 (読み込みエラー):</strong></p>
            <ul>${errorDetails.map(e => `<li>${e}</li>`).join('')}</ul>
          </div>`;
        }
        html += '</div>';
        newsList.innerHTML = html;
      }
    }

  } catch (err) {
    console.error('Core news error:', err);
    const failMsg = 'お知らせの読み込み中にエラーが発生しました。';
    if (newsStrip) newsStrip.textContent = failMsg;
    if (newsList) {
      newsList.innerHTML = `
        <div style="text-align: center; padding: 4rem;">
          <p>${failMsg}</p>
          <div class="debug-error-box"><p>${err.message}</p></div>
        </div>
      `;
    }
  }
});

function parseMarkdownWithFrontmatter(text) {
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  const frontmatterRegex = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]*([\s\S]*)$/;
  const match = cleanText.match(frontmatterRegex);

  if (!match) {
    return { title: 'No Title', date: '', category: 'その他', content: cleanText };
  }

  const yamlBlock = match[1];
  const content = match[2];
  const metadata = {};

  yamlBlock.split('\n').forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      if (key) metadata[key] = value;
    }
  });

  return {
    title: metadata.title || 'No Title',
    date: metadata.date || '',
    category: metadata.category || 'その他',
    content: content.trim()
  };
}

function getCatClass(cat) {
  if (cat === 'リリース') return 'cat-release';
  if (cat === '重要') return 'cat-important';
  if (cat === 'アップデート予告') return 'cat-update';
  return 'cat-other';
}
