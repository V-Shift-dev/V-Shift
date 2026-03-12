document.addEventListener('DOMContentLoaded', async () => {
  const newsStrip = document.getElementById('latest-news-content');
  const newsList = document.getElementById('news-list');

  try {
    // 1. Fetch the list of markdown files
    const response = await fetch('news_index.json');
    const fileNames = await response.json();

    const announcements = [];

    // 2. Fetch and parse each markdown file
    for (const fileName of fileNames) {
      const res = await fetch(fileName);
      const text = await res.text();
      const parsed = parseMarkdownWithFrontmatter(text);
      announcements.push(parsed);
    }

    // 3. Sort by date (descending) - assuming index might not be sorted
    announcements.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Latest news for index.html strip
    if (newsStrip && announcements.length > 0) {
      const latest = announcements[0];
      newsStrip.innerHTML = `
                <span class="news-date">${latest.date}</span>
                <a href="news.html">${latest.title}</a>
            `;
    }

    // Full list for news.html
    if (newsList) {
      newsList.innerHTML = announcements.map(news => `
                <div class="news-item">
                    <div class="news-meta">
                        <span class="news-date">${news.date}</span>
                        <span class="news-cat ${getCatClass(news.category)}">${news.category}</span>
                    </div>
                    <h3>${news.title}</h3>
                    <div class="news-md-content">${marked.parse(news.content)}</div>
                </div>
            `).join('');
    }
  } catch (err) {
    console.error('Error fetching news:', err);
    if (newsStrip) newsStrip.textContent = 'お知らせの読み込みに失敗しました。';
    if (newsList) newsList.innerHTML = '<p>お知らせの読み込みに失敗しました。</p>';
  }
});

/**
 * Simple parser for Markdown with YAML-like frontmatter
 * Format:
 * ---
 * title: String
 * date: YYYY-MM-DD
 * category: String
 * ---
 * Content...
 */
function parseMarkdownWithFrontmatter(text) {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = text.match(frontmatterRegex);

  if (!match) {
    return {
      title: 'No Title',
      date: '',
      category: 'その他',
      content: text
    };
  }

  const yamlBlock = match[1];
  const content = match[2];
  const metadata = {};

  yamlBlock.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length > 0) {
      metadata[key.trim()] = valueParts.join(':').trim();
    }
  });

  return {
    ...metadata,
    content: content.trim()
  };
}

function getCatClass(cat) {
  if (cat === 'リリース') return 'cat-release';
  if (cat === '重要') return 'cat-important';
  return 'cat-other';
}
