import { readFileSync, existsSync } from 'fs';
import {
  BenchmarkData,
  Executor as ApiExecutor,
  Suite as ApiSuite,
  Benchmark as ApiBenchmark,
  RunId as ApiRunId,
  Source as ApiSource,
  Environment as ApiEnvironment,
  Criterion as ApiCriterion,
  DataPoint as ApiDataPoint,
  ProfileData as ApiProfileData,
  BenchmarkCompletion,
  TimelineRequest,
  TimelineResponse,
  PlotData,
  FullPlotData,
  TimelineSuite
} from './api.js';
import pg, { PoolConfig, QueryConfig, QueryResultRow } from 'pg';
import { getDirname, TotalCriterion } from './util.js';
import { assert } from './logging.js';
import { simplifyCmdline } from './views/util.js';
import { SummaryStatistics } from './stats.js';
import { BatchingTimelineUpdater } from './timeline-calc.js';

const __dirname = getDirname(import.meta.url);

function isUniqueViolationError(err) {
  return err.code === '23505';
}

export interface DatabaseConfig {
  user: string;
  password: string;
  host: string;
  database: string;
  port: number;
}

export function loadScheme(): string {
  let schema = `${__dirname}/../src/db/db.sql`;
  if (!existsSync(schema)) {
    schema = `${__dirname}/../../src/db/db.sql`;
  }

  return readFileSync(schema).toString();
}

export interface Executor {
  id: number;
  name: string;
  description: string;
}

export interface Suite {
  id: number;
  name: string;
  description: string;
}

export interface Benchmark {
  id: number;
  name: string;
  description: string;
}

export interface SoftwareVersionInfo {
  id: number;
  name: string;
  version: string;
}

export interface Environment {
  id: number;
  hostname: string;
  ostype: string;
  memory: number;
  cpu: string;
  clockspeed: number;
  note: string;
}

export interface Unit {
  name: string;
  description: string;
  lessisbetter: boolean;
}

export interface Criterion {
  id: number;
  name: string;
  unit: string;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  description: string;
  logo: string;
  showchanges: boolean;
  allresults: boolean;
  githubnotification: boolean;
  basebranch: string;
}

export interface Source {
  id: number;
  repourl: string;
  branchortag: string;
  commitid: string;
  commitmessage: string;
  authorname: string;
  authoremail: string;
  committername: string;
  committeremail: string;
}

export interface Experiment {
  id: number;

  name: string;
  projectid: number;

  description: string;
}

export interface Trial {
  id: number;
  manualrun: boolean;
  starttime: string;

  expid: number;

  username: string;
  envid: number;
  sourceid: number;

  denoise: string;
  endTime: string;
}

export interface SoftwareUse {
  envid: string;
  softid: string;
}

export interface Run {
  id: number;
  benchmarkid: number;
  suiteid: number;
  execid: number;
  cmdline: string;

  /** The current working directory. */
  location: string;

  varvalue: string | null;
  cores: string | null;
  inputsize: string | null;
  extraargs: string | null;
  maxinvocationtime: number;
  miniterationtime: number;
  warmup: number;
}

export interface Measurement {
  runid: number;
  trialid: number;
  criterion: number;
  invocation: number;
  iteration: number;

  value: number;
}

export interface Baseline extends Source {
  firststart: string;
}

function filterCommitMessage(msg) {
  return msg
    .replaceAll('\\n', '\n') // resolve new lines
    .replace(/Signed-off-by:.*/g, '') // remove signed-off-by lines
    .trim();
}

export class TimedCacheValidity {
  private valid: boolean;
  private scheduledInvalidation: boolean;

  /** Delay in milliseconds. */
  private readonly invalidationDelay: number;

  constructor(invalidationDelay: number) {
    this.invalidationDelay = invalidationDelay;
    this.valid = true;
    this.scheduledInvalidation = false;
  }

  public invalidateAndNew(): TimedCacheValidity {
    if (!this.scheduledInvalidation) {
      this.scheduledInvalidation = true;
      if (this.invalidationDelay === 0) {
        this.valid = false;
      } else {
        setTimeout(() => {
          this.valid = false;
        }, this.invalidationDelay);
      }
    }

    if (this.valid) {
      return this;
    }
    return new TimedCacheValidity(this.invalidationDelay);
  }

  public isValid(): boolean {
    return this.valid;
  }
}

export abstract class Database {
  protected readonly dbConfig: PoolConfig;

  private readonly executors: Map<string, Executor>;
  private readonly suites: Map<string, Suite>;
  private readonly benchmarks: Map<string, Benchmark>;
  private readonly runs: Map<string, Run>;
  private readonly sources: Map<string, Source>;
  private readonly envs: Map<string, Environment>;
  private readonly trials: Map<string, Trial>;
  private readonly exps: Map<string, Experiment>;
  private readonly criteria: Map<string, Criterion>;
  private readonly projects: Map<string, Project>;

  private readonly timelineUpdater: BatchingTimelineUpdater | null;

  private readonly queries = {
    fetchProjectByName: 'SELECT * FROM Project WHERE name = $1',
    insertMeasurementBatchedN: 'GENERATED'
  };

  private static readonly batchN = 50;

  protected statsValid: TimedCacheValidity;

  constructor(
    config: PoolConfig,
    numBootstrapSamples = 1000,
    timelineEnabled = false,
    cacheInvalidationDelay = 0
  ) {
    assert(config !== undefined);
    this.dbConfig = config;
    this.executors = new Map();
    this.suites = new Map();
    this.benchmarks = new Map();
    this.runs = new Map();
    this.sources = new Map();
    this.envs = new Map();
    this.exps = new Map();
    this.trials = new Map();
    this.criteria = new Map();
    this.projects = new Map();
    this.statsValid = new TimedCacheValidity(cacheInvalidationDelay);

    this.queries.insertMeasurementBatchedN = `INSERT INTO Measurement
         (runId, trialId, invocation, iteration, criterion, value)
       VALUES ${this.generateBatchInsert(Database.batchN, 6)}
       ON CONFLICT DO NOTHING`;

    if (timelineEnabled) {
      this.timelineUpdater = new BatchingTimelineUpdater(
        this,
        numBootstrapSamples
      );
    } else {
      this.timelineUpdater = null;
    }
  }

  public getStatsCacheValidity(): TimedCacheValidity {
    return this.statsValid;
  }

  private invalidateStatsCache() {
    this.statsValid = this.statsValid.invalidateAndNew();
  }

  private generateBatchInsert(numTuples: number, sizeTuples: number) {
    const nums: string[] = [];
    for (let i = 0; i < numTuples; i += 1) {
      const tupleNums: number[] = [];
      for (let j = 1; j <= sizeTuples; j += 1) {
        tupleNums.push(i * sizeTuples + j);
      }
      nums.push('($' + tupleNums.join(', $') + ')');
    }
    return nums.join(',\n');
  }

  public abstract query<R extends pg.QueryResultRow = any>(
    queryConfig: QueryConfig<any[]>
  ): Promise<pg.QueryResult<R>>;

  public clearCache(): void {
    this.executors.clear();
    this.suites.clear();
    this.benchmarks.clear();
    this.runs.clear();
    this.sources.clear();
    this.envs.clear();
    this.exps.clear();
    this.trials.clear();
    this.criteria.clear();
    this.projects.clear();
  }

  private async needsTables() {
    const result = await this.query({
      name: 'doTableExist',
      text: `SELECT *
                FROM   information_schema.tables
                WHERE  table_name = 'executor'`
    });
    return result.rowCount <= 0;
  }

  public async initializeDatabase(): Promise<void> {
    if (await this.needsTables()) {
      const schema = loadScheme();
      await this.query({ text: schema });
    }
  }

  public async close(): Promise<void> {
    if (this.timelineUpdater) {
      await this.timelineUpdater.shutdown();
    }
  }

  public async revisionsExistInProject(
    projectSlug: string,
    base: string,
    change: string
  ): Promise<{ dataFound: boolean; base?: any; change?: any }> {
    const result = await this.query({
      name: 'fetchRevisionsInProjectByCommitIds',
      text: `SELECT DISTINCT
          p.id, e.name, s.id,
          s.commitid, s.repoUrl, s.branchOrTag,
          s.commitMessage, s.authorName
        FROM Project p
          JOIN Experiment e ON e.projectId = p.id
          JOIN Trial t ON e.id = t.expId
          JOIN Source s ON t.sourceId = s.id
        WHERE lower(p.slug) = lower($1)
          AND s.commitid = $2
          OR s.commitid = $3`,
      values: [projectSlug, base, change]
    });

    // we can have multiple experiments with the same revisions
    if (result.rowCount >= 2) {
      let baseData;
      let changeData;
      for (const row of result.rows) {
        if (row.commitid === base) {
          baseData = row;
        } else if (row.commitid === change) {
          changeData = row;
        }
      }

      baseData.commitmessage = filterCommitMessage(baseData.commitmessage);
      changeData.commitmessage = filterCommitMessage(changeData.commitmessage);

      return {
        dataFound: true,
        base: baseData,
        change: changeData
      };
    } else {
      return { dataFound: false };
    }
  }

  private async getCached(cache, cacheKey, fetchQ: QueryConfig): Promise<any> {
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const result = await this.query(fetchQ);
    if (result.rowCount === 1) {
      return result[0];
    }
    return null;
  }

  private async recordCached(
    cache,
    cacheKey,
    fetchQ: QueryConfig,
    insertQ: QueryConfig
  ) {
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    let result = await this.query(fetchQ);
    if (result.rowCount === 0) {
      try {
        result = await this.query(insertQ);
      } catch (e) {
        // there may have been a racy insert,
        // which causes us to fail on unique constraints
        result = await this.query(fetchQ);
        if (result.rowCount === 0) {
          throw e;
        }
      }
    }

    assert(result.rowCount === 1);
    cache.set(cacheKey, result.rows[0]);
    return result.rows[0];
  }

  public async recordExecutor(e: ApiExecutor): Promise<Executor> {
    return this.recordCached(
      this.executors,
      e.name,
      {
        name: 'fetchExecutorByName',
        text: 'SELECT * from Executor WHERE name = $1',
        values: [e.name]
      },
      {
        name: 'insertExecutor',
        text: `INSERT INTO Executor (name, description)
                  VALUES ($1, $2) RETURNING *`,
        values: [e.name, e.desc]
      }
    );
  }

  public async recordSuite(s: ApiSuite): Promise<Suite> {
    return this.recordCached(
      this.suites,
      s.name,
      {
        name: 'fetchSuiteByName',
        text: 'SELECT * from Suite WHERE name = $1',
        values: [s.name]
      },
      {
        name: 'insertSuite',
        text: `INSERT INTO Suite (name, description)
                  VALUES ($1, $2) RETURNING *`,
        values: [s.name, s.desc]
      }
    );
  }

  public async recordBenchmark(b: ApiBenchmark): Promise<Benchmark> {
    return this.recordCached(
      this.benchmarks,
      b.name,
      {
        name: 'fetchBenchmarkByName',
        text: 'SELECT * from Benchmark WHERE name = $1',
        values: [b.name]
      },
      {
        name: 'insertBenchmark',
        text: `INSERT INTO Benchmark (name, description)
                  VALUES ($1, $2) RETURNING *`,
        values: [b.name, b.desc]
      }
    );
  }

  public async recordRun(run: ApiRunId): Promise<Run> {
    if (this.runs.has(run.cmdline)) {
      return <Run>this.runs.get(run.cmdline);
    }

    const exec = await this.recordExecutor(run.benchmark.suite.executor);
    const suite = await this.recordSuite(run.benchmark.suite);
    const benchmark = await this.recordBenchmark(run.benchmark);

    return this.recordCached(
      this.runs,
      run.cmdline,
      {
        name: 'fetchRunByCmdline',
        text: 'SELECT * from Run WHERE cmdline = $1',
        values: [run.cmdline]
      },
      {
        name: 'insertRun',
        text: `INSERT INTO Run (
                  cmdline,
                  benchmarkId, execId, suiteId,
                  location,
                  cores, inputSize, varValue, extraArgs,
                  maxInvocationTime, minIterationTime, warmup)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING *`,
        values: [
          run.cmdline,
          benchmark.id,
          exec.id,
          suite.id,
          run.location,
          run.cores,
          run.inputSize,
          run.varValue,
          run.extraArgs,
          run.benchmark.runDetails.maxInvocationTime,
          run.benchmark.runDetails.minIterationTime,
          run.benchmark.runDetails.warmup
        ]
      }
    );
  }

  public async recordSource(s: ApiSource): Promise<Source> {
    return this.recordCached(
      this.sources,
      s.commitId,
      {
        name: 'fetchSourceById',
        text: 'SELECT * from Source WHERE commitId = $1',
        values: [s.commitId]
      },
      {
        name: 'insertSource',
        text: `INSERT INTO Source (
                  repoURL, branchOrTag, commitId, commitMessage,
                  authorName, authorEmail, committerName, committerEmail)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        values: [
          s.repoURL,
          s.branchOrTag,
          s.commitId,
          s.commitMsg,
          s.authorName,
          s.authorEmail,
          s.committerName,
          s.committerEmail
        ]
      }
    );
  }

  public async recordEnvironment(e: ApiEnvironment): Promise<Environment> {
    return this.recordCached(
      this.envs,
      e.hostName,
      {
        name: 'fetchEnvironmentByHostname',
        text: 'SELECT * from Environment WHERE hostname =  $1',
        values: [e.hostName]
      },
      {
        name: 'insertEnvironment',
        text: `INSERT INTO Environment (
                  hostname, osType, memory, cpu, clockSpeed)
                VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        values: [e.hostName, e.osType, e.memory, e.cpu, e.clockSpeed]
      }
    );
  }

  public async recordTrial(
    data: BenchmarkData,
    env: Environment,
    exp: Experiment
  ): Promise<Trial> {
    const e = data.env;
    const cacheKey = `${e.userName}-${env.id}-${data.startTime}-${exp.id}`;

    if (this.trials.has(cacheKey)) {
      return <Trial>this.trials.get(cacheKey);
    }
    const source = await this.recordSource(data.source);

    return this.recordCached(
      this.trials,
      cacheKey,
      {
        name: 'fetchTrialByUserEnvIdStartTimeExpId',
        text: `SELECT * FROM Trial
                  WHERE username = $1 AND envId = $2 AND
                        startTime = $3 AND expId = $4`,
        values: [e.userName, env.id, data.startTime, exp.id]
      },
      {
        name: 'insertTrial',
        text: `INSERT INTO Trial (manualRun, startTime, expId, username,
                        envId, sourceId, denoise)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        values: [
          e.manualRun,
          data.startTime,
          exp.id,
          e.userName,
          env.id,
          source.id,
          e.denoise
        ]
      }
    );
  }

  public async recordProject(projectName: string): Promise<Project> {
    return this.recordCached(
      this.projects,
      projectName,
      {
        name: 'fetchProjectByName',
        text: this.queries.fetchProjectByName,
        values: [projectName]
      },
      {
        name: 'insertProject',
        text: `INSERT INTO Project (name, slug)
                  VALUES ($1, regexp_replace($2, '[^0-9a-zA-Z-]', '-', 'g'))
                RETURNING *`,
        values: [projectName, projectName]
      }
    );
  }

  public async getProjectBySlug(
    projectNameSlug: string
  ): Promise<Project | undefined> {
    const q = {
      name: 'fetchProjectBySlugName',
      text: `SELECT * FROM Project
              WHERE lower($1) = lower(slug)`,
      values: [projectNameSlug]
    };

    const result = await this.query(q);

    if (result.rowCount !== 1) {
      return undefined;
    }
    return result.rows[0];
  }

  public async getProjectByExpId(expId: number): Promise<Project | undefined> {
    const q = {
      name: 'fetchProjectByExpId',
      text: `SELECT p.* FROM Project p
              JOIN Experiment e ON e.projectId = p.id
              WHERE e.id = $1`,
      values: [expId]
    };

    const result = await this.query(q);

    if (result.rowCount !== 1) {
      return undefined;
    }
    return result.rows[0];
  }

  public async getProjectByName(projectName: string): Promise<Project | null> {
    return <Promise<Project | null>>this.getCached(this.projects, projectName, {
      name: 'fetchProjectByName',
      text: this.queries.fetchProjectByName,
      values: [projectName]
    });
  }

  public async getAllProjects(): Promise<Project[]> {
    const result = await this.query({
      name: 'fetchAllProjects',
      text: 'SELECT * FROM Project ORDER BY position DESC'
    });
    return result.rows;
  }

  public async getProject(projectId: number): Promise<Project | undefined> {
    const result = await this.query({
      name: 'fetchProjectById',
      text: 'SELECT * FROM Project WHERE id = $1',
      values: [projectId]
    });

    if (result.rowCount !== 1) {
      return undefined;
    } else {
      return result.rows[0];
    }
  }

  public async setProjectBaseBranch(
    projectName: string,
    baseBranch: string
  ): Promise<boolean> {
    const result = await this.query({
      text: `UPDATE Project
                SET baseBranch = $2
                WHERE name = $1`,
      values: [projectName, baseBranch]
    });
    return result.rowCount === 1;
  }

  public async getBaselineCommit(
    projectName: string,
    currentCommitId: string
  ): Promise<Baseline | undefined> {
    const result = await this.query({
      name: 'fetchBaselineCommit',
      text: `SELECT DISTINCT s.*, min(t.startTime) as firstStart
              FROM Source s
                JOIN Trial t ON s.id = t.sourceId
                JOIN Experiment e ON e.id = t.expId
                JOIN Project p ON p.id = e.projectId
              WHERE p.name = $1 AND
                s.branchOrTag = p.baseBranch AND
                s.commitId <> $2 AND
                p.baseBranch IS NOT NULL
              GROUP BY e.id, s.id
              ORDER BY firstStart DESC
              LIMIT 1`,
      values: [projectName, currentCommitId]
    });

    if (result.rowCount < 1) {
      return undefined;
    } else {
      return result.rows[0];
    }
  }

  public async getSourceById(
    projectSlug: string,
    sourceId: string
  ): Promise<Source | null> {
    const q: QueryConfig = {
      name: 'get-source-by-slug-id',
      text: `SELECT DISTINCT s.*
              FROM Source s
                JOIN Trial t       ON t.sourceId = s.id
                JOIN Experiment e  ON e.id = t.expId
                JOIN Project p     ON p.id = e.projectId
              WHERE p.name = $1 AND s.id = $2
              LIMIT 1`,
      values: [projectSlug, sourceId]
    };

    const result = await this.query(q);
    if (result.rowCount < 1) {
      return null;
    }
    return result.rows[0];
  }

  public async getSourceByNames(
    projectName: string,
    experimentName: string
  ): Promise<Source | undefined> {
    const result = await this.query({
      name: 'fetchSourceByProjectNameExpName',
      text: `SELECT DISTINCT s.*
              FROM Source s
                JOIN Trial t ON s.id = t.sourceId
                JOIN Experiment e ON e.id = t.expId
                JOIN Project p ON p.id = e.projectId
              WHERE p.name = $1 AND e.name = $2`,
      values: [projectName, experimentName]
    });

    if (result.rowCount < 1) {
      return undefined;
    } else {
      return result.rows[0];
    }
  }

  public async recordExperiment(data: BenchmarkData): Promise<Experiment> {
    const cacheKey = `${data.projectName}::${data.experimentName}`;

    if (this.exps.has(cacheKey)) {
      return <Experiment>this.exps.get(cacheKey);
    }

    const project = await this.recordProject(data.projectName);

    return this.recordCached(
      this.exps,
      cacheKey,
      {
        name: 'fetchExperimentByProjectIdAndName',
        text: 'SELECT * FROM Experiment WHERE projectId = $1 AND name = $2',
        values: [project.id, data.experimentName]
      },
      {
        name: 'insertExperiment',
        text: `INSERT INTO Experiment (name, projectId, description)
                  VALUES ($1, $2, $3) RETURNING *`,
        values: [data.experimentName, project.id, data.experimentDesc]
      }
    );
  }

  public async getExperimentByNames(
    projectName: string,
    experimentName: string
  ): Promise<Experiment | undefined> {
    const cacheKey = `${projectName}::${experimentName}`;
    if (this.exps.has(cacheKey)) {
      return this.exps.get(cacheKey);
    }

    const result = await this.query({
      name: 'fetchExperimentByProjectNameExpName',
      text: `SELECT e.* FROM Experiment e
              JOIN Project p ON p.id = e.projectId
              WHERE p.name = $1 AND e.name = $2`,
      values: [projectName, experimentName]
    });

    if (result.rowCount < 1) {
      return undefined;
    }
    return result.rows[0];
  }

  public async getExperimentDetails(
    expId: number,
    projectSlug: string
  ): Promise<{
    project: string;
    expName: string;
    expDesc: string;
    projectId: number;
    projectDesc: string;
  } | null> {
    const result = await this.query({
      name: 'fetchExpDataByIdAndProjectSlug',
      text: `SELECT
                  exp.name as expName,
                  exp.description as expDesc,
                  p.id as pId,
                  p.name as pName,
                  p.description as pDesc
                FROM
                  Experiment exp
                JOIN Project p ON exp.projectId = p.id

                WHERE exp.id = $1 AND
                  lower(p.slug) = lower($2)`,
      values: [expId, projectSlug]
    });
    if (!result || result.rows.length !== 1) {
      return null;
    }

    return {
      project: result.rows[0].pname,
      expName: result.rows[0].expname,
      expDesc: result.rows[0].expDesc,
      projectId: result.rows[0].pid,
      projectDesc: result.rows[0].pdesc
    };
  }

  public async getExperimentMeasurements(expId: number): Promise<
    {
      expid: number;
      runid: number;
      trialid: number;
      commitid: string;
      bench: string;
      exe: string;
      suite: string;
      cmdline: string;
      varvalue: string;
      cores: string;
      inputsize: string;
      extraargs: string;
      invocation: number;
      iteration: number;
      warmup: number;
      criterion: string;
      unit: string;
      value: number;
      envid: number;
    }[]
  > {
    const result = await this.query({
      name: 'fetchExpMeasurements',
      text: `SELECT
                expId, runId, trialId,
                substring(commitId, 1, 6) as commitid,
                benchmark.name as bench,
                executor.name as exe,
                suite.name as suite,
                cmdline, varValue, cores, inputSize, extraArgs,
                invocation, iteration, warmup,
                criterion.name as criterion, criterion.unit as unit,
                value, envid
              FROM Measurement
                JOIN Trial ON trialId = Trial.id
                JOIN Experiment ON expId = Experiment.id
                JOIN Source ON source.id = sourceId
                JOIN Criterion ON criterion = criterion.id
                JOIN Run ON runId = run.id
                JOIN Suite ON suiteId = suite.id
                JOIN Benchmark ON benchmarkId = benchmark.id
                JOIN Executor ON execId = executor.id
              WHERE
                Experiment.id = $1
              ORDER BY
                runId, trialId, cmdline, invocation, iteration, criterion`,
      values: [expId]
    });
    return result.rows;
  }

  public async recordExperimentCompletion(
    expId: number,
    endTime: string
  ): Promise<void> {
    await this.query({
      name: 'setTrialEndTime',
      text: `UPDATE Trial t
              SET endTime = $2
              WHERE expId = $1 AND endTime IS NULL`,
      values: [expId, endTime]
    });
  }

  public async reportCompletion(
    data: BenchmarkCompletion
  ): Promise<Experiment> {
    const exp = await this.getExperimentByNames(
      data.projectName,
      data.experimentName
    );
    if (exp === undefined) {
      throw new Error(
        `Could not record completion, no experiment found for ` +
          `${data.projectName} ${data.experimentName}`
      );
    }

    if (!data.endTime) {
      throw new Error(`Could not record completion without endTime`);
    }

    await this.recordExperimentCompletion(exp.id, data.endTime);
    return exp;
  }

  private async recordUnit(unitName: string) {
    const result = await this.query({
      name: 'fetchUnitByName',
      text: 'SELECT * from Unit WHERE name = $1',
      values: [unitName]
    });
    if (result.rowCount === 0) {
      await this.query({
        name: 'insertUnit',
        text: 'INSERT INTO Unit (name) VALUES ($1)',
        values: [unitName]
      });
    }
  }

  public async recordCriterion(c: ApiCriterion): Promise<Criterion> {
    const cacheKey = `${c.c}::${c.u}`;

    if (this.criteria.has(cacheKey)) {
      return <Criterion>this.criteria.get(cacheKey);
    }

    await this.recordUnit(c.u);
    return this.recordCached(
      this.criteria,
      cacheKey,
      {
        name: 'fetchCriterionByNameAndUnit',
        text: 'SELECT * FROM Criterion WHERE name = $1 AND unit = $2',
        values: [c.c, c.u]
      },
      {
        name: 'insertCriterion',
        text: 'INSERT INTO Criterion (name, unit) VALUES ($1, $2) RETURNING *',
        values: [c.c, c.u]
      }
    );
  }

  private async resolveCriteria(
    data: ApiCriterion[]
  ): Promise<Map<number, Criterion>> {
    const criteria: Map<number, Criterion> = new Map();
    for (const c of data) {
      criteria.set(c.i, await this.recordCriterion(c));
    }
    return criteria;
  }

  private async retrieveAvailableMeasurements(trialId: number) {
    const results = await this.query({
      name: 'fetchAvailableMeasurements',
      text: `SELECT
              runId, criterion, invocation as inv, max(iteration) as ite
            FROM Measurement
            WHERE trialId = $1
            GROUP BY runId, criterion, invocation
            ORDER BY runId, inv, ite, criterion`,
      values: [trialId]
    });

    const measurements = {};
    for (const r of results.rows) {
      // runid, criterion, inv, ite
      if (!(r.runid in measurements)) {
        measurements[r.runid] = {};
      }

      const run = measurements[r.runid];

      if (!(r.criterion in run)) {
        run[r.criterion] = {};
      }

      const crit = run[r.criterion];

      assert(
        !(r.inv in crit),
        `${r.runid}, ${r.criterion}, ${r.inv} in ${JSON.stringify(crit)}`
      );
      crit[r.inv] = r.ite;
    }

    return measurements;
  }

  private alreadyRecorded(
    measurements,
    [runId, _expId, inv, ite, critId, _val]: any[]
  ) {
    if (runId in measurements) {
      const run = measurements[runId];
      if (critId in run) {
        const crit = run[critId];
        if (inv in crit) {
          return crit[inv] >= ite;
        }
      }
    }

    return false;
  }

  private async recordMeasurementsFromBatch(batchedValues: any[]) {
    let recordedMeasurements = 0;

    while (batchedValues.length > 0) {
      // there are 6 parameters, i.e., values
      const rest = batchedValues.splice(6 * 1);
      try {
        const result = await this.recordMeasurement(batchedValues);
        recordedMeasurements += result;
      } catch (err) {
        // looks like we already have this data
        if (!isUniqueViolationError(err)) {
          throw err;
        }
      }
      batchedValues = rest;
    }

    return recordedMeasurements;
  }

  public async recordProfiles(
    profiles: ApiProfileData[],
    run: any,
    trial: any
  ): Promise<number> {
    let recordedProfiles = 0;

    for (const p of profiles) {
      let data = p.d;
      if (typeof data !== 'string') {
        data = JSON.stringify(p.d);
      }
      recordedProfiles += await this.recordProfile(
        run.id,
        trial.id,
        p.in,
        p.nit,
        data
      );
    }

    return recordedProfiles;
  }

  public async recordMeasurements(
    dataPoints: ApiDataPoint[],
    run: any,
    trial: any,
    criteria: Map<number, Criterion>,
    availableMs: any
  ): Promise<number> {
    let recordedMeasurements = 0;
    let batchedMs = 0;
    let batchedValues: any[] = [];

    for (const d of dataPoints) {
      for (const m of d.m) {
        // batched inserts are much faster
        // so let's do this
        const criterion = <Criterion>criteria.get(m.c);
        const values = [run.id, trial.id, d.in, d.it, criterion.id, m.v];
        if (this.alreadyRecorded(availableMs, values)) {
          // then,just skip this one.
          continue;
        }

        if (this.timelineUpdater && criterion.name === TotalCriterion) {
          this.timelineUpdater.addValue(run.id, trial.id, criterion.id, m.v);
        }
        batchedMs += 1;
        batchedValues = batchedValues.concat(values);
        if (batchedMs === Database.batchN) {
          try {
            const result = await this.recordMeasurementBatchedN(batchedValues);
            recordedMeasurements += result;
          } catch (err) {
            // we may have concurrent inserts, or partially inserted data,
            // where a request aborted
            if (isUniqueViolationError(err)) {
              recordedMeasurements += await this.recordMeasurementsFromBatch(
                batchedValues
              );
            } else {
              throw err;
            }
          }
          batchedValues = [];
          batchedMs = 0;
        }
      }
    }

    while (batchedValues.length >= 6 * 10) {
      // there are 6 parameters, i.e., values
      const rest = batchedValues.splice(6 * 10);
      try {
        const result = await this.recordMeasurementBatched10(batchedValues);
        recordedMeasurements += result;
      } catch (err) {
        if (isUniqueViolationError(err)) {
          recordedMeasurements += await this.recordMeasurementsFromBatch(
            batchedValues
          );
        }
      }
      batchedValues = rest;
    }

    recordedMeasurements += await this.recordMeasurementsFromBatch(
      batchedValues
    );

    return recordedMeasurements;
  }

  public async recordMetaData(data: BenchmarkData): Promise<{
    env: Environment;
    exp: Experiment;
    trial: Trial;
    criteria: Map<number, Criterion>;
  }> {
    const env = await this.recordEnvironment(data.env);
    const exp = await this.recordExperiment(data);
    const trial = await this.recordTrial(data, env, exp);

    let criteria;
    if (data.criteria) {
      criteria = await this.resolveCriteria(data.criteria);
    } else {
      criteria = null;
    }

    return { env, exp, trial, criteria };
  }

  public async recordAllData(
    data: BenchmarkData,
    suppressTimelineGeneration = false
  ): Promise<[number, number]> {
    this.invalidateStatsCache();
    const { trial, criteria } = await this.recordMetaData(data);

    let recordedMeasurements = 0;
    let recordedProfiles = 0;

    for (const r of data.data) {
      const run = await this.recordRun(r.runId);

      if (r.d) {
        const availableMs = await this.retrieveAvailableMeasurements(trial.id);
        recordedMeasurements += await this.recordMeasurements(
          r.d,
          run,
          trial,
          criteria,
          availableMs
        );
      }

      if (r.p) {
        recordedProfiles += await this.recordProfiles(r.p, run, trial);
      }
    }

    if (
      recordedMeasurements > 0 &&
      this.timelineUpdater &&
      !suppressTimelineGeneration
    ) {
      this.timelineUpdater.submitUpdateJobs();
    }

    return [recordedMeasurements, recordedProfiles];
  }

  public getTimelineUpdater(): BatchingTimelineUpdater | null {
    return this.timelineUpdater;
  }

  public async recordMetaDataAndRuns(data: BenchmarkData): Promise<number> {
    await this.recordMetaData(data);

    for (const r of data.data) {
      await this.recordRun(r.runId);
    }

    return data.data.length;
  }

  public async recordMeasurementBatched10(values: any[]): Promise<number> {
    const q = {
      name: 'insertMeasurement10',
      text: `INSERT INTO Measurement
          (runId, trialId, invocation, iteration, criterion, value)
        VALUES
          ($1, $2, $3, $4, $5, $6),
          ($7, $8, $9, $10, $11, $12),
          ($13, $14, $15, $16, $17, $18),
          ($19, $20, $21, $22, $23, $24),
          ($25, $26, $27, $28, $29, $30),
          ($31, $32, $33, $34, $35, $36),
          ($37, $38, $39, $40, $41, $42),
          ($43, $44, $45, $46, $47, $48),
          ($49, $50, $51, $52, $53, $54),
          ($55, $56, $57, $58, $59, $60)
          ON CONFLICT DO NOTHING`,
      // [runId, trialId, invocation, iteration, critId, value];
      values
    };

    return (await this.query(q)).rowCount;
  }

  public async recordMeasurementBatchedN(values: any[]): Promise<number> {
    const q = {
      name: 'insertMeasurementN',
      text: this.queries.insertMeasurementBatchedN,
      // [runId, trialId, invocation, iteration, critId, value];
      values
    };

    q.values = values;
    return (await this.query(q)).rowCount;
  }

  public async recordMeasurement(values: any[]): Promise<number> {
    const q = {
      name: 'insertMeasurement',
      text: `INSERT INTO Measurement
          (runId, trialId, invocation, iteration, criterion, value)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING`,
      // [runId, trialId, invocation, iteration, critId, value];
      values
    };

    return (await this.query(q)).rowCount;
  }

  public async recordTimeline(
    runId: number,
    trialId: number,
    criterion: number,
    stats: SummaryStatistics
  ): Promise<number> {
    const q = {
      name: 'insertTimelineStats',
      text: `INSERT INTO timeline
              (runid, trialid, criterion,
               minval, maxval, sdval, mean, median,
               numsamples, bci95low, bci95up)
             VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (runid, trialid, criterion) DO UPDATE
             SET
               minval = EXCLUDED.minval,
               maxval = EXCLUDED.maxval,
               sdval  = EXCLUDED.sdval,
               mean   = EXCLUDED.mean,
               median = EXCLUDED.median,
               numsamples = EXCLUDED.numsamples,
               bci95low = EXCLUDED.bci95low,
               bci95up = EXCLUDED.bci95up;`,
      values: [
        runId,
        trialId,
        criterion,
        stats.min,
        stats.max,
        stats.standardDeviation,
        stats.mean,
        stats.median,
        stats.numberOfSamples,
        stats.bci95low,
        stats.bci95up
      ]
    };
    return (await this.query(q)).rowCount;
  }

  public async recordProfile(
    runId: number,
    trialId: number,
    invocation: number,
    numIterations: number,
    value: string
  ): Promise<number> {
    const q = {
      name: 'insertProfile',
      text: `INSERT INTO ProfileData
          (runId, trialId, invocation, numIterations, value)
        VALUES
          ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING`,
      values: [runId, trialId, invocation, numIterations, value]
    };
    return (await this.query(q)).rowCount;
  }

  public async awaitQuiescentTimelineUpdater(): Promise<void> {
    await this.timelineUpdater?.getQuiescencePromise();
  }

  public async getBranchNames(
    projectName: string,
    base: string,
    change: string
  ): Promise<null | { baseBranchName: string; changeBranchName: string }> {
    const q = {
      name: 'fetchBranchNamesForChange',
      text: `SELECT DISTINCT branchOrTag, s.commitId
             FROM Source s
               JOIN Trial      tr ON tr.sourceId = s.id
               JOIN Experiment e  ON tr.expId = e.id
               JOIN Project    p  ON p.id = e.projectId
             WHERE
               p.name = $1 AND
               (s.commitid = $2 OR s.commitid = $3)`,
      values: [projectName, base, change]
    };
    const result = await this.query(q);

    if (result.rowCount < 1) {
      return null;
    }

    if (result.rowCount == 1) {
      return {
        baseBranchName: result.rows[0].branchortag,
        changeBranchName: result.rows[0].branchortag
      };
    }

    assert(result.rowCount == 2);
    if (result.rows[0].commitid == base) {
      return {
        baseBranchName: result.rows[0].branchortag,
        changeBranchName: result.rows[1].branchortag
      };
    }

    assert(result.rows[0].commitid == change);
    return {
      baseBranchName: result.rows[1].branchortag,
      changeBranchName: result.rows[0].branchortag
    };
  }

  public async getLatestBenchmarksForTimelineView(
    projectId: number
  ): Promise<TimelineSuite[] | null> {
    const q = {
      name: 'fetchLatestBenchmarksForProject',
      text: `WITH LatestExperiment AS (
                SELECT exp.id as expId, max(t.startTime) as newest
                FROM Project p
                  JOIN Experiment exp    ON exp.projectId = p.id
                  JOIN Trial t           ON t.expId = exp.id
                  JOIN Source src        ON t.sourceId = src.id
                WHERE p.id = $1 AND
                  p.baseBranch = src.branchOrTag
                GROUP BY exp.id
                ORDER BY newest DESC
                LIMIT 1
              )
              SELECT DISTINCT
                s.id as suiteId, s.name as suiteName,
                exe.id as execId, exe.name as execName,
                b.id as benchId, b.name as benchmark,
                r.cmdline,
                r.id as runId,
                r.varValue,
                r.cores,
                r.inputSize,
                r.extraArgs
              FROM Project p
                JOIN Experiment exp    ON exp.projectId = p.id
                JOIN Trial t           ON t.expId = exp.id
                JOIN Source src        ON t.sourceId = src.id
                JOIN Environment env   ON t.envId = env.id
                JOIN Timeline tl       ON tl.trialId = t.id
                JOIN Run r             ON tl.runId = r.id
                JOIN Benchmark b       ON r.benchmarkId = b.id
                JOIN Suite s           ON r.suiteId = s.id
                JOIN Executor exe      ON r.execId = exe.id
                JOIN LatestExperiment le ON exp.id = le.expId
              WHERE
                p.id = $1 AND
                p.baseBranch = src.branchOrTag
              ORDER BY suiteName, execName, benchmark, cmdline;`,
      values: [projectId]
    };

    const result = await this.query(q);
    if (result.rowCount < 1) {
      return null;
    }

    let suiteId: number | null = null;
    let exeId: number | null = null;

    const suites: TimelineSuite[] = [];
    let currentSuite: TimelineSuite | null = null;
    let currentExec: any = null;

    for (const r of result.rows) {
      if (r.suiteid !== suiteId) {
        currentSuite = {
          suiteId: r.suiteid,
          suiteName: r.suitename,
          exec: []
        };
        suites.push(currentSuite);
        suiteId = r.suiteId;
      }

      if (r.execid !== exeId) {
        currentExec = {
          execId: r.execid,
          execName: r.execname,
          benchmarks: []
        };
        currentSuite?.exec.push(currentExec);
        exeId = r.execid;
      }

      currentExec.benchmarks.push({
        benchId: r.benchid,
        benchName: r.benchmark,
        cmdline: simplifyCmdline(r.cmdline),
        runId: r.runid,
        varValue: r.varvalue,
        cores: r.cores,
        inputSize: r.inputsize,
        extraArgs: r.extraargs
      });
    }

    return suites;
  }

  public async getTimelineForRun(
    projectId: number,
    runId: number
  ): Promise<TimelineResponse | null> {
    const q = this.constructTimelineQueryForRun(projectId, runId);
    const result = await this.query(q);

    if (result.rowCount < 1) {
      return null;
    }

    return this.convertToTimelineResponse(result.rows, null, null);
  }

  public async getTimelineData(
    projectName: string,
    request: TimelineRequest
  ): Promise<TimelineResponse | null> {
    const branches = await this.getBranchNames(
      projectName,
      request.baseline,
      request.change
    );

    if (branches === null) {
      return null;
    }

    const q = this.constructTimelineQuery(projectName, branches, request);
    const result = await this.query(q);

    if (result.rowCount < 1) {
      return null;
    }

    const data = this.convertToTimelineResponse(
      result.rows,
      branches.baseBranchName,
      branches.changeBranchName
    );
    return data;
  }

  private convertToTimelineResponse(
    rows: any[],
    baseBranchName: string | null,
    changeBranchName: string | null
  ): TimelineResponse {
    let baseTimestamp: number | null = null;
    let changeTimestamp: number | null = null;
    const sourceIds: number[] = [];
    const data: PlotData =
      baseBranchName !== null
        ? [
            [], // time stamp
            [], // baseline bci low
            [], // baseline median
            [], // baseline bci high
            [], // change bci low
            [], // change median
            [] // change bci high
          ]
        : [
            [], // time stamp
            [], // baseline bci low
            [], // baseline median
            [] // baseline bci high
          ];

    for (const row of rows) {
      data[0].push(row.starttime);
      sourceIds.push(<number>parseInt(row.sourceid));
      if (baseBranchName === null || row.branch == baseBranchName) {
        if (baseBranchName !== null && row.iscurrent) {
          baseTimestamp = row.starttime;
        }
        data[1].push(row.bci95low);
        data[2].push(row.median);
        data[3].push(row.bci95up);
        if (baseBranchName !== null) {
          (<FullPlotData>data)[4].push(null);
          (<FullPlotData>data)[5].push(null);
          (<FullPlotData>data)[6].push(null);
        }
      } else {
        if (row.iscurrent) {
          changeTimestamp = row.starttime;
        }
        data[1].push(null);
        data[2].push(null);
        data[3].push(null);
        if (baseBranchName !== null) {
          (<FullPlotData>data)[4].push(row.bci95low);
          (<FullPlotData>data)[5].push(row.median);
          (<FullPlotData>data)[6].push(row.bci95up);
        }
      }
    }

    return {
      baseBranchName,
      changeBranchName,
      baseTimestamp,
      changeTimestamp,
      data,
      sourceIds
    };
  }

  private constructTimelineQueryForRun(
    projectId: number,
    runId: number
  ): QueryConfig {
    const sql = `
      SELECT
        extract(epoch from tr.startTime at time zone 'UTC')::int as startTime,
        s.branchOrTag as branch,
        s.id as sourceId,
        ti.median, ti.bci95low, ti.bci95up
      FROM Timeline ti
        JOIN Trial      tr ON tr.id = ti.trialId
        JOIN Source     s  ON tr.sourceId = s.id
        JOIN Experiment e  ON tr.expId = e.id
        JOIN Project    p  ON p.id = e.projectId
        JOIN Run        r  ON r.id = ti.runId
        JOIN Criterion  c  ON ti.criterion = c.id
      WHERE
        s.branchOrTag = p.baseBranch AND
        p.id = $1   AND
        r.id = $2   AND
        c.name   = '${TotalCriterion}'
      ORDER BY tr.startTime ASC;
    `;
    return {
      name: 'get-timeline-data-for-pid-runid',
      text: sql,
      values: [projectId, runId]
    };
  }

  private constructTimelineQuery(
    projectName: string,
    branches: { baseBranchName: string; changeBranchName: string },
    request: TimelineRequest
  ): QueryConfig {
    let sql = `
      SELECT
        extract(epoch from tr.startTime at time zone 'UTC')::int as startTime,
        s.branchOrTag as branch, s.commitid IN ($1, $2) as isCurrent,
        s.id as sourceId,
        ti.median, ti.bci95low, ti.bci95up
      FROM Timeline ti
        JOIN Trial      tr ON tr.id = ti.trialId
        JOIN Source     s  ON tr.sourceId = s.id
        JOIN Experiment e  ON tr.expId = e.id
        JOIN Project    p  ON p.id = e.projectId
        JOIN Run        r  ON r.id = ti.runId
        JOIN Executor  exe ON exe.id = r.execId
        JOIN Benchmark  b  ON b.id = r.benchmarkId
        JOIN Suite      su ON su.id = r.suiteId
        JOIN Criterion  c  ON ti.criterion = c.id
      WHERE
        s.branchOrTag IN ($3, $4) AND
        p.name = $5   AND
        b.name = $6   AND
        su.name = $7  AND
        exe.name = $8 AND
        c.name   = '${TotalCriterion}'
        ::ADDITIONAL-PARAMETERS::
      ORDER BY tr.startTime ASC;
    `;

    let additionalParameters = '';
    let storedQueryName = 'get-timeline-data-bpbs-';

    const parameters = [
      request.baseline,
      request.change,
      branches.baseBranchName,
      branches.changeBranchName,
      projectName,
      request.b,
      request.s,
      request.e
    ];

    if (request.v) {
      parameters.push(request.v);
      additionalParameters += 'AND r.varValue = $' + parameters.length + ' ';
      storedQueryName += 'v';
    }

    if (request.c) {
      parameters.push(request.c);
      additionalParameters += 'AND r.cores = $' + parameters.length + ' ';
      storedQueryName += 'c';
    }

    if (request.i) {
      parameters.push(request.i);
      additionalParameters += 'AND r.inputSize = $' + parameters.length + ' ';
      storedQueryName += 'i';
    }

    if (request.ea) {
      parameters.push(request.ea);
      additionalParameters += 'AND r.extraArgs = $' + parameters.length + ' ';
      storedQueryName += 'ea';
    }

    sql = sql.replace('::ADDITIONAL-PARAMETERS::', additionalParameters);

    return {
      name: storedQueryName,
      text: sql,
      values: parameters
    };
  }
}

export class DatabaseWithPool extends Database {
  private pool: pg.Pool;

  constructor(
    config: PoolConfig,
    numReplicates = 1000,
    timelineEnabled = false,
    cacheInvalidationDelay = 0
  ) {
    super(config, numReplicates, timelineEnabled, cacheInvalidationDelay);
    this.pool = new pg.Pool(config);
  }

  public async query<R extends QueryResultRow = any>(
    queryConfig: QueryConfig<any[]>
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query(queryConfig);
  }

  public async close(): Promise<void> {
    await super.close();
    this.statsValid.invalidateAndNew();
    await this.pool.end();
    (<any>this).pool = null;
  }
}
