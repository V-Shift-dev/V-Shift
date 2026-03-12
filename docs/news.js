document.addEventListener('DOMContentLoaded', async () => {
  const newsStrip = document.getElementById('latest-news-content');
  const newsList = document.getElementById('news-list');

  console.log('News initialization started.');

  try {
    // 1. Fetch the list of markdown files
    const response = await fetch('news_index.json');
    if (!response.ok) throw new Error(`Failed to fetch news_index.json: ${response.status}`);
    const fileNames = await response.json();
    console.log('News index loaded:', fileNames);

    const announcements = [];

    // 2. Fetch and parse each markdown file
    for (const fileName of fileNames) {
      try {
        console.log(`Fetching ${fileName}...`);
        const res = await fetch(fileName);
        if (!res.ok) {
          console.warn(`Could not fetch ${fileName}: ${res.status}`);
          continue;
        }
        const text = await res.text();
        console.log(`Fetched ${fileName}, length: ${text.length}`);

        const parsed = parseMarkdownWithFrontmatter(text);
        announcements.push(parsed);
      } catch (fileErr) {
        console.error(`Error processing ${fileName}:`, fileErr);
      }
    }

    // 3. Sort by date (descending)
    announcements.sort((a, b) => {
      const dateA = new Date(a.date || 0);
      const dateB = new Date(b.date || 0);
      return dateB - dateA;
    });

    console.log('Parsed announcements:', announcements);

    // Latest news for index.html strip
    if (newsStrip && announcements.length > 0) {
      const latest = announcements[0];
      newsStrip.innerHTML = `
                <span class="news-date">${latest.date || ''}</span>
                <a href="news.html">${latest.title || 'No Title'}</a>
            `;
    } else if (newsStrip) {
      newsStrip.textContent = '現在、新しいお知らせはありません。';
    }

    // Full list for news.html
    if (newsList) {
      if (announcements.length === 0) {
        newsList.innerHTML = '<div style="text-align: center; padding: 4rem;"><p>お知らせはありません。</p></div>';
      } else {
        newsList.innerHTML = announcements.map(news => `
                  <div class="news-item">
                      <div class="news-meta">
                          <span class="news-date">${news.date || ''}</span>
                          <span class="news-cat ${getCatClass(news.category)}">${news.category || 'その他'}</span>
                      </div>
                      <h3>${news.title || 'No Title'}</h3>
                      <div class="news-md-content">${marked.parse(news.content || '')}</div>
                  </div>
              `).join('');
      }
    }
  } catch (err) {
    console.error('Error fetching news:', err);
    if (newsStrip) newsStrip.textContent = 'お知らせの読み込みに失敗しました。';
    if (newsList) newsList.innerHTML = '<div style="text-align: center; padding: 4rem;"><p>お知らせの読み込みに失敗しました。</p></div>';
  }
});

/**
 * Robust parser for Markdown with YAML-like frontmatter
 */
function parseMarkdownWithFrontmatter(text) {
  // Remove BOM and trim start/end
  const cleanText = text.replace(/^\uFEFF/, '').trim();

  // Lenient regex: allows optional \r, more whitespace, and optional ending newline
  const frontmatterRegex = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*[\r\n]*([\s\S]*)$/;
  const match = cleanText.match(frontmatterRegex);

  if (!match) {
    console.warn('Frontmatter match failed. Text snippet:', cleanText.substring(0, 100));
    return {
      title: 'No Title',
      date: '',
      category: 'その他',
      content: cleanText
    };
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

