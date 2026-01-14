import axios, { AxiosInstance } from 'axios';

/*******************************************************************************
 * Types
 *******************************************************************************/

interface GraphQLResponse {
  data?: {
    viewer?: {
      login?: string;
      name?: string;
      repositories?: RepositoryPage;
      repositoriesContributedTo?: RepositoryPage;
      contributionsCollection?: ContributionsCollection;
      [key: string]: unknown;
    };
  };
  errors?: Array<{ message: string }>;
}

interface RepositoryPage {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: Repository[];
}

interface Repository {
  nameWithOwner: string;
  stargazers: {
    totalCount: number;
  };
  forkCount: number;
  languages: {
    edges: LanguageEdge[];
  };
}

interface LanguageEdge {
  size: number;
  node: {
    name: string;
    color: string | null;
  };
}

interface ContributionsCollection {
  contributionYears: number[];
  contributionCalendar: {
    totalContributions: number;
  };
}

interface LanguageData {
  size: number;
  occurrences: number;
  color: string | null;
  prop?: number;
}

interface RESTResponse {
  author?: {
    login: string;
  };
  weeks?: Array<{
    a: number;
    d: number;
  }>;
  views?: Array<{
    count: number;
  }>;
  [key: string]: unknown;
}

/*******************************************************************************
 * Main Classes
 *******************************************************************************/

export class Queries {
  private username: string;
  private accessToken: string;
  private client: AxiosInstance;
  private maxConnections: number;
  private semaphore: number;
  private activeRequests: number = 0;
  private requestQueue: Array<() => void> = [];

  constructor(
    username: string,
    accessToken: string,
    maxConnections: number = 10
  ) {
    this.username = username;
    this.accessToken = accessToken;
    this.maxConnections = maxConnections;
    this.semaphore = maxConnections;
    this.client = axios.create({
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
  }

  private async acquireSemaphore(): Promise<void> {
    return new Promise((resolve) => {
      if (this.activeRequests < this.maxConnections) {
        this.activeRequests++;
        resolve();
      } else {
        this.requestQueue.push(() => {
          this.activeRequests++;
          resolve();
        });
      }
    });
  }

  private releaseSemaphore(): void {
    this.activeRequests--;
    if (this.requestQueue.length > 0) {
      const next = this.requestQueue.shift();
      if (next) {
        next();
      }
    }
  }

  async query(generatedQuery: string): Promise<GraphQLResponse> {
    await this.acquireSemaphore();
    try {
      const response = await this.client.post<GraphQLResponse>(
        'https://api.github.com/graphql',
        { query: generatedQuery }
      );
      return response.data || {};
    } catch (error) {
      console.error('GraphQL query failed:', error instanceof Error ? error.message : 'Unknown error');
      // Fall back on direct axios request
      try {
        const response = await axios.post<GraphQLResponse>(
          'https://api.github.com/graphql',
          { query: generatedQuery },
          {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
            },
          }
        );
        return response.data || {};
      } catch (fallbackError) {
        console.error('GraphQL query fallback failed:', fallbackError instanceof Error ? fallbackError.message : 'Unknown error');
        return {};
      }
    } finally {
      this.releaseSemaphore();
    }
  }

  async queryRest(path: string, params?: Record<string, string | number | boolean>): Promise<RESTResponse | RESTResponse[]> {
    const maxAttempts = 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.acquireSemaphore();
      try {
        let url = path;
        if (url.startsWith('/')) {
          url = url.substring(1);
        }
        url = `https://api.github.com/${url}`;

        const response = await this.client.get<RESTResponse | RESTResponse[]>(url, {
          params: params || {},
          headers: {
            Authorization: `token ${this.accessToken}`,
          },
        });

        if (response.status === 202) {
          // GitHub API returns 202 when data is being computed
          // Use Retry-After header if available, otherwise use exponential backoff
          const retryAfter = response.headers['retry-after'];
          const delay = retryAfter 
            ? parseInt(retryAfter, 10) * 1000 
            : Math.min(2000 * Math.pow(1.5, attempt), 10000); // Exponential backoff, max 10s
          
          if (attempt < 5 || attempt % 10 === 0) {
            console.log(`GitHub API is computing statistics for ${path} (attempt ${attempt + 1}/${maxAttempts}). Waiting ${Math.round(delay / 1000)}s...`);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          this.releaseSemaphore();
          continue;
        }

        return response.data || {};
      } catch (error: unknown) {
        this.releaseSemaphore();
        // Check if it's a 202 in error response
        if (axios.isAxiosError(error) && error.response?.status === 202) {
          const retryAfter = error.response.headers['retry-after'];
          const delay = retryAfter 
            ? parseInt(retryAfter, 10) * 1000 
            : Math.min(2000 * Math.pow(1.5, attempt), 10000);
          
          if (attempt < 5 || attempt % 10 === 0) {
            console.log(`GitHub API is computing statistics for ${path} (attempt ${attempt + 1}/${maxAttempts}). Waiting ${Math.round(delay / 1000)}s...`);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        
        console.error(`REST query failed for ${path}:`, error instanceof Error ? error.message : 'Unknown error');
        // Fall back on direct axios request
        try {
          let url = path;
          if (url.startsWith('/')) {
            url = url.substring(1);
          }
          url = `https://api.github.com/${url}`;

          const response = await axios.get<RESTResponse | RESTResponse[]>(url, {
            params: params || {},
            headers: {
              Authorization: `token ${this.accessToken}`,
            },
          });

          if (response.status === 202) {
            const retryAfter = response.headers['retry-after'];
            const delay = retryAfter 
              ? parseInt(retryAfter, 10) * 1000 
              : Math.min(2000 * Math.pow(1.5, attempt), 10000);
            
            if (attempt < 5 || attempt % 10 === 0) {
              console.log(`GitHub API is computing statistics for ${path} (attempt ${attempt + 1}/${maxAttempts}). Waiting ${Math.round(delay / 1000)}s...`);
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          } else if (response.status === 200) {
            return response.data || {};
          }
        } catch (fallbackError) {
          // Continue to next attempt
        }
      } finally {
        this.releaseSemaphore();
      }
    }
    console.warn(`GitHub API did not return data for ${path} after ${maxAttempts} attempts. This is normal for repositories with complex statistics.`);
    return {};
  }

  static reposOverview(
    contribCursor: string | null = null,
    ownedCursor: string | null = null
  ): string {
    return `{
  viewer {
    login,
    name,
    repositories(
        first: 100,
        orderBy: {
            field: UPDATED_AT,
            direction: DESC
        },
        isFork: false,
        after: ${ownedCursor === null ? 'null' : `"${ownedCursor}"`}
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        nameWithOwner
        stargazers {
          totalCount
        }
        forkCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node {
              name
              color
            }
          }
        }
      }
    }
    repositoriesContributedTo(
        first: 100,
        includeUserRepositories: false,
        orderBy: {
            field: UPDATED_AT,
            direction: DESC
        },
        contributionTypes: [
            COMMIT,
            PULL_REQUEST,
            REPOSITORY,
            PULL_REQUEST_REVIEW
        ]
        after: ${contribCursor === null ? 'null' : `"${contribCursor}"`}
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        nameWithOwner
        stargazers {
          totalCount
        }
        forkCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node {
              name
              color
            }
          }
        }
      }
    }
  }
}
`;
  }

  static contribYears(): string {
    return `
query {
  viewer {
    contributionsCollection {
      contributionYears
    }
  }
}
`;
  }

  static contribsByYear(year: string): string {
    return `
    year${year}: contributionsCollection(
        from: "${year}-01-01T00:00:00Z",
        to: "${parseInt(year) + 1}-01-01T00:00:00Z"
    ) {
      contributionCalendar {
        totalContributions
      }
    }
`;
  }

  static allContribs(years: string[]): string {
    const byYears = years.map((year) => this.contribsByYear(year)).join('\n');
    return `
query {
  viewer {
    ${byYears}
  }
}
`;
  }
}

export class Stats {
  private username: string;
  private ignoreForkedRepos: boolean;
  private excludeRepos: Set<string>;
  private excludeLangs: Set<string>;
  private queries: Queries;

  private _name: string | null = null;
  private _stargazers: number | null = null;
  private _forks: number | null = null;
  private _totalContributions: number | null = null;
  private _languages: Record<string, LanguageData> | null = null;
  private _repos: Set<string> | null = null;
  private _linesChanged: [number, number] | null = null;
  private _views: number | null = null;

  constructor(
    username: string,
    accessToken: string,
    excludeRepos?: Set<string> | null,
    excludeLangs?: Set<string> | null,
    ignoreForkedRepos: boolean = false
  ) {
    this.username = username;
    this.ignoreForkedRepos = ignoreForkedRepos;
    this.excludeRepos = excludeRepos || new Set();
    this.excludeLangs = excludeLangs || new Set();
    this.queries = new Queries(username, accessToken);
  }

  async toStr(): Promise<string> {
    const languages = await this.getLanguagesProportional();
    const formattedLanguages = Object.entries(languages)
      .map(([k, v]) => `${k}: ${v.toFixed(4)}%`)
      .join('\n  - ');
    const linesChanged = await this.getLinesChanged();
    return `Name: ${await this.getName()}
Stargazers: ${(await this.getStargazers()).toLocaleString()}
Forks: ${(await this.getForks()).toLocaleString()}
All-time contributions: ${(await this.getTotalContributions()).toLocaleString()}
Repositories with contributions: ${(await this.getRepos()).size}
Lines of code added: ${linesChanged[0].toLocaleString()}
Lines of code deleted: ${linesChanged[1].toLocaleString()}
Lines of code changed: ${(linesChanged[0] + linesChanged[1]).toLocaleString()}
Project page views: ${(await this.getViews()).toLocaleString()}
Languages:
  - ${formattedLanguages}`;
  }

  async getStats(): Promise<void> {
    this._stargazers = 0;
    this._forks = 0;
    this._languages = {};
    this._repos = new Set();

    const excludeLangsLower = new Set(
      Array.from(this.excludeLangs).map((x) => x.toLowerCase())
    );

    let nextOwned: string | null = null;
    let nextContrib: string | null = null;
    let hasMorePages = true;

    while (hasMorePages) {
      const rawResults = await this.queries.query(
        Queries.reposOverview(nextOwned, nextContrib)
      );

      this._name =
        rawResults.data?.viewer?.name ||
        rawResults.data?.viewer?.login ||
        'No Name';

      const contribRepos = rawResults.data?.viewer?.repositoriesContributedTo;
      const ownedRepos = rawResults.data?.viewer?.repositories;

      const repos: Repository[] = ownedRepos?.nodes || [];
      if (!this.ignoreForkedRepos && contribRepos?.nodes) {
        repos.push(...contribRepos.nodes);
      }

      for (const repo of repos) {
        if (!repo) {
          continue;
        }
        const name = repo.nameWithOwner;
        if (this._repos.has(name) || this.excludeRepos.has(name)) {
          continue;
        }
        this._repos.add(name);
        this._stargazers += repo.stargazers?.totalCount || 0;
        this._forks += repo.forkCount || 0;

        for (const lang of repo.languages?.edges || []) {
          const langName = lang.node?.name || 'Other';
          if (!this._languages) {
            this._languages = {};
          }
          if (excludeLangsLower.has(langName.toLowerCase())) {
            continue;
          }
          if (langName in this._languages) {
            this._languages[langName].size += lang.size || 0;
            this._languages[langName].occurrences += 1;
          } else {
            this._languages[langName] = {
              size: lang.size || 0,
              occurrences: 1,
              color: lang.node?.color || null,
            };
          }
        }
      }

      hasMorePages =
        (ownedRepos?.pageInfo?.hasNextPage || false) ||
        (contribRepos?.pageInfo?.hasNextPage || false);
      if (hasMorePages) {
        nextOwned = ownedRepos?.pageInfo?.endCursor || nextOwned;
        nextContrib = contribRepos?.pageInfo?.endCursor || nextContrib;
      }
    }

    // Calculate proportions
    if (this._languages) {
      const langsTotal = Object.values(this._languages).reduce(
        (sum, v) => sum + (v.size || 0),
        0
      );
      for (const k of Object.keys(this._languages)) {
        const v = this._languages[k];
        v.prop = 100 * ((v.size || 0) / langsTotal);
      }
    }
  }

  async getName(): Promise<string> {
    if (this._name !== null) {
      return this._name;
    }
    await this.getStats();
    if (this._name === null) {
      throw new Error('Name is null after getStats');
    }
    return this._name;
  }

  async getStargazers(): Promise<number> {
    if (this._stargazers !== null) {
      return this._stargazers;
    }
    await this.getStats();
    if (this._stargazers === null) {
      throw new Error('Stargazers is null after getStats');
    }
    return this._stargazers;
  }

  async getForks(): Promise<number> {
    if (this._forks !== null) {
      return this._forks;
    }
    await this.getStats();
    if (this._forks === null) {
      throw new Error('Forks is null after getStats');
    }
    return this._forks;
  }

  async getLanguages(): Promise<Record<string, LanguageData>> {
    if (this._languages !== null) {
      return this._languages;
    }
    await this.getStats();
    if (this._languages === null) {
      throw new Error('Languages is null after getStats');
    }
    return this._languages;
  }

  async getLanguagesProportional(): Promise<Record<string, number>> {
    if (this._languages === null) {
      await this.getStats();
      if (this._languages === null) {
        throw new Error('Languages is null after getStats');
      }
    }

    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(this._languages!)) {
      result[k] = v.prop || 0;
    }
    return result;
  }

  async getRepos(): Promise<Set<string>> {
    if (this._repos !== null) {
      return this._repos;
    }
    await this.getStats();
    if (this._repos === null) {
      throw new Error('Repos is null after getStats');
    }
    return this._repos;
  }

  async getTotalContributions(): Promise<number> {
    if (this._totalContributions !== null) {
      return this._totalContributions;
    }

    this._totalContributions = 0;
    const yearsResponse = await this.queries.query(Queries.contribYears());
    const years =
      yearsResponse.data?.viewer?.contributionsCollection?.contributionYears ||
      [];

    const byYearResponse = await this.queries.query(
      Queries.allContribs(years.map((y) => y.toString()))
    );

    const byYear = Object.values(byYearResponse.data?.viewer || {});
    for (const year of byYear) {
      const contribs =
        (year as ContributionsCollection).contributionCalendar
          ?.totalContributions || 0;
      this._totalContributions += contribs;
    }

    return this._totalContributions;
  }

  async getLinesChanged(): Promise<[number, number]> {
    if (this._linesChanged !== null) {
      return this._linesChanged;
    }

    let additions = 0;
    let deletions = 0;
    const repos = await this.getRepos();

    for (const repo of repos) {
      const r = await this.queries.queryRest(
        `/repos/${repo}/stats/contributors`
      );
      const contributors = Array.isArray(r) ? r : [r];

      for (const authorObj of contributors) {
        // Handle malformed response from the API by skipping this repo
        if (
          typeof authorObj !== 'object' ||
          authorObj === null ||
          typeof (authorObj as RESTResponse).author !== 'object' ||
          (authorObj as RESTResponse).author === null
        ) {
          continue;
        }
        const author = (authorObj as RESTResponse).author?.login || '';
        if (author !== this.username) {
          continue;
        }

        for (const week of (authorObj as RESTResponse).weeks || []) {
          additions += week.a || 0;
          deletions += week.d || 0;
        }
      }
    }

    this._linesChanged = [additions, deletions];
    return this._linesChanged;
  }

  async getViews(): Promise<number> {
    if (this._views !== null) {
      return this._views;
    }

    let total = 0;
    const repos = await this.getRepos();

    for (const repo of repos) {
      const r = await this.queries.queryRest(`/repos/${repo}/traffic/views`);
      const response = Array.isArray(r) ? r[0] : r;
      for (const view of (response as RESTResponse).views || []) {
        total += view.count || 0;
      }
    }

    this._views = total;
    return total;
  }
}

/*******************************************************************************
 * Main Function
 *******************************************************************************/

export async function main(): Promise<void> {
  /**
   * Used mostly for testing; this module is not usually run standalone
   */
  const accessToken = process.env.ACCESS_TOKEN;
  const user = process.env.GITHUB_ACTOR;
  if (!accessToken || !user) {
    throw new RuntimeError(
      'ACCESS_TOKEN and GITHUB_ACTOR environment variables cannot be None!'
    );
  }
  const s = new Stats(user, accessToken);
  console.log(await s.toStr());
}

class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}
