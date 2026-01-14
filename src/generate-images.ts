import * as fs from 'fs';
import * as path from 'path';
import { Stats } from './github-stats';

/*******************************************************************************
 * Helper Functions
 *******************************************************************************/

function generateOutputFolder(): void {
  /**
   * Create the output folder if it does not already exist
   */
  const outputDir = 'generated';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

/*******************************************************************************
 * Individual Image Generation Functions
 *******************************************************************************/

async function generateOverview(s: Stats): Promise<void> {
  /**
   * Generate an SVG badge with summary statistics
   * :param s: Represents user's GitHub statistics
   */
  const templatePath = path.join('templates', 'overview.svg');
  let output = fs.readFileSync(templatePath, 'utf-8');

  output = output.replace(/\{\{ name \}\}/g, await s.getName());
  output = output.replace(/\{\{ stars \}\}/g, (await s.getStargazers()).toLocaleString());
  output = output.replace(/\{\{ forks \}\}/g, (await s.getForks()).toLocaleString());
  output = output.replace(
    /\{\{ contributions \}\}/g,
    (await s.getTotalContributions()).toLocaleString()
  );
  const changed = (await s.getLinesChanged())[0] + (await s.getLinesChanged())[1];
  output = output.replace(/\{\{ lines_changed \}\}/g, changed.toLocaleString());
  output = output.replace(/\{\{ views \}\}/g, (await s.getViews()).toLocaleString());
  output = output.replace(/\{\{ repos \}\}/g, (await s.getRepos()).size.toLocaleString());

  generateOutputFolder();
  const outputPath = path.join('generated', 'overview.svg');
  fs.writeFileSync(outputPath, output);
}

async function generateLanguages(s: Stats): Promise<void> {
  /**
   * Generate an SVG badge with summary languages used
   * :param s: Represents user's GitHub statistics
   */
  const templatePath = path.join('templates', 'languages.svg');
  let output = fs.readFileSync(templatePath, 'utf-8');

  let progress = '';
  let langList = '';
  const languages = await s.getLanguages();
  const sortedLanguages = Object.entries(languages).sort(
    (a, b) => (b[1].size || 0) - (a[1].size || 0)
  );
  const delayBetween = 150;
  for (let i = 0; i < sortedLanguages.length; i++) {
    const [lang, data] = sortedLanguages[i];
    const color = data.color || '#000000';
    progress += `<span style="background-color: ${color};width: ${(data.prop || 0).toFixed(3)}%;" class="progress-item"></span>`;
    langList += `
<li style="animation-delay: ${i * delayBetween}ms;">
<svg xmlns="http://www.w3.org/2000/svg" class="octicon" style="fill:${color};"
viewBox="0 0 16 16" version="1.1" width="16" height="16"><path
fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8z"></path></svg>
<span class="lang">${lang}</span>
<span class="percent">${(data.prop || 0).toFixed(2)}%</span>
</li>

`;
  }

  output = output.replace(/\{\{ progress \}\}/g, progress);
  output = output.replace(/\{\{ lang_list \}\}/g, langList);

  generateOutputFolder();
  const outputPath = path.join('generated', 'languages.svg');
  fs.writeFileSync(outputPath, output);
}

/*******************************************************************************
 * Main Function
 *******************************************************************************/

async function main(): Promise<void> {
  /**
   * Generate all badges
   */
  const accessToken = process.env.ACCESS_TOKEN;
  if (!accessToken) {
    console.warn(
      '⚠️  WARNING: ACCESS_TOKEN is not set!\n' +
      'Please set a valid GitHub Personal Access Token.\n' +
      'Get one at: https://github.com/settings/tokens\n' +
      'Example: $env:ACCESS_TOKEN = "your_token_here"\n' +
      'The script will exit without generating images.'
    );
    process.exit(0);
  }
  if (accessToken === 'YOUR_GITHUB_TOKEN' || accessToken.length < 20) {
    console.warn(
      '⚠️  WARNING: Invalid ACCESS_TOKEN detected!\n' +
      'Please set a valid GitHub Personal Access Token.\n' +
      'Get one at: https://github.com/settings/tokens\n' +
      'The script will exit without generating images.'
    );
    process.exit(0);
  }
  const user = process.env.GITHUB_ACTOR;
  if (!user) {
    console.warn(
      '⚠️  WARNING: GITHUB_ACTOR is not set!\n' +
      'Please set a valid GitHub username.\n' +
      'Example: $env:GITHUB_ACTOR = "your_username"\n' +
      'The script will exit without generating images.'
    );
    process.exit(0);
  }
  const excludeRepos = process.env.EXCLUDED;
  const excludedRepos = excludeRepos
    ? new Set(excludeRepos.split(',').map((x) => x.trim()))
    : null;
  const excludeLangs = process.env.EXCLUDED_LANGS;
  const excludedLangs = excludeLangs
    ? new Set(excludeLangs.split(',').map((x) => x.trim()))
    : null;
  // Convert a truthy value to a Boolean
  const rawIgnoreForkedRepos = process.env.EXCLUDE_FORKED_REPOS;
  const ignoreForkedRepos =
    !!rawIgnoreForkedRepos &&
    rawIgnoreForkedRepos.trim().toLowerCase() !== 'false';

  const s = new Stats(
    user,
    accessToken,
    excludedRepos,
    excludedLangs,
    ignoreForkedRepos
  );
  await Promise.all([generateLanguages(s), generateOverview(s)]);
}

export { main };
