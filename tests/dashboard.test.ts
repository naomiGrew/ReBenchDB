import { TestDatabase, createAndInitializeDB } from './db-testing';
import { dashStatistics, dashResults, dashChanges, dashProjects, dashDataOverview, dashBenchmarksForProject } from '../src/dashboard';
import { BenchmarkData } from '../src/api';
import { readFileSync } from 'fs';

describe('Test Dashboard on empty DB', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createAndInitializeDB('dash_empty');
  });

  afterAll(async () => {
    await db.close();
  });

  afterEach(async () => {
    await db.rollback();
  });

  it('Should get empty results request', async () => {
    const result = await dashResults(0, db);
    expect(result.timeSeries).toEqual({});
  });

  it('Should get empty statistics', async () => {
    const result = await dashStatistics(db);
    expect(result.stats.length).toBeGreaterThan(1);
    for (const table of result.stats) {
      expect(table.cnt).toEqual('0');
    }
  });

  it('Should get empty changes', async () => {
    const result = await dashChanges(0, db);
    expect(result.changes).toHaveLength(0);
  });
});

describe('Test Dashboard with basic test data loaded', () => {
  let db: TestDatabase;

  // switch suites to use a template database

  beforeAll(async () => {
    db = await createAndInitializeDB('dash_basic', 25, true, false);

    const basicTestData: BenchmarkData = JSON.parse(
      readFileSync(`${__dirname}/small-payload.json`).toString());
    await db.recordMetaDataAndRuns(basicTestData);
    await db.recordAllData(basicTestData);
  });

  afterAll(async () => {
    await db.close();
  });

  it('Should get a project', async () => {
    const projects = (await dashProjects(db)).projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toEqual('Small Example Project');
    expect(projects[0].id).toEqual(1);
  });

  it('Should get results, but does not have any values', async () => {
    const results = (await dashResults(1, db)).timeSeries;
    expect(results['NBody']).toHaveLength(3);
    expect(results['NBody'][0]).toBeCloseTo(383.82, 2);
  });

  it('Should get statistics', async () => {
    const result = (await dashStatistics(db)).stats;
    expect(result.length).toBeGreaterThan(2);

    for (const table of result) {
      if (table.table === 'Measurements') {
        expect(table.cnt).toEqual('3');
      } else {
        expect(table.cnt).toEqual('1');
      }
    }
  });

  it('Should get change', async () => {
    const result = (await dashChanges(1, db)).changes;
    expect(result).toHaveLength(1);
    expect(result[0].commitid).toEqual('58666d1c84c652306f930daa72e7a47c58478e86');
  });

  it('Should get available data for DataOverview', async () => {
    await db.awaitQuiescentTimelineUpdater();
    const data = (await dashDataOverview(1, db)).data;
    expect(data).toHaveLength(1);
    expect(data[0].commitids).toEqual("58666d1c84c652306f930daa72e7a47c58478e86");
    expect(data[0].expid).toEqual(1);
    expect(data[0].name).toEqual("Small Test Case");
  });

  it('Should get benchmarks for project', async () => {
    await db.awaitQuiescentTimelineUpdater();
    const data = (await dashBenchmarksForProject(db, 1)).benchmarks;
    expect(data).toHaveLength(1);
    expect(data[0].benchid).toEqual(1);
    expect(data[0].benchmark).toEqual("NBody");
  });

  // dashTimelineForProject


  // dashCompare
  // dashGetExpData

});
