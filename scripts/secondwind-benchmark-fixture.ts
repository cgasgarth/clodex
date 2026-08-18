#!/usr/bin/env bun

interface DeploymentFixture {
  deploymentId: string;
  rollbackAt?: string | null;
  warnings: string[] | null;
  owner: { team: string; email?: string };
  status: string;
  region: string | undefined;
}

function fixtureAt<Value>(records: Value[], index: number): Value {
  const value = records[index];
  if (value === undefined) throw new Error(`Missing benchmark fixture at index ${index}`);
  return value;
}

function deployments(): void {
  const records: DeploymentFixture[] = Array.from({ length: 90 }, (_, index) => ({
    deploymentId: `dep-${String(index).padStart(4, '0')}`,
    rollbackAt: index % 5 === 0 ? null : `2026-07-${String((index % 27) + 1).padStart(2, '0')}T12:00:00Z`,
    warnings: index % 7 === 0 ? [] : [`warning-${index % 19}`],
    owner: index % 11 === 0 ? { team: `team-${index % 31}` } : {
      team: `team-${index % 31}`,
      email: `owner-${index}@example.com`,
    },
    status: index % 4 === 0 ? 'ready' : 'deployed',
    region: ['us-east-1', 'us-west-2', 'eu-west-1'][index % 3],
  }));

  records[60] = {
    ...fixtureAt(records, 60),
    rollbackAt: null,
    warnings: [],
    owner: { team: 'team-7' },
    status: 'ready',
  };
  records[61] = {
    ...fixtureAt(records, 61),
    rollbackAt: null,
    warnings: null,
    owner: { team: 'team-7' },
    status: 'blocked',
  };
  const absentRollback = {
    ...fixtureAt(records, 62),
    warnings: [],
    owner: { team: 'team-7' },
    status: 'blocked',
  };
  delete absentRollback.rollbackAt;
  records[62] = absentRollback;
  records[63] = {
    ...fixtureAt(records, 63),
    rollbackAt: '',
    warnings: [],
    owner: { team: 'team-7' },
    status: 'blocked',
  };
  records[64] = {
    ...fixtureAt(records, 64),
    rollbackAt: null,
    warnings: [],
    owner: { team: 'team-7', email: '' },
    status: 'blocked',
  };
  records[67] = {
    ...fixtureAt(records, 67),
    deploymentId: 'dep-rollback-null-417',
    rollbackAt: null,
    warnings: [],
    owner: { team: 'team-7' },
    status: 'blocked',
  };

  console.log(JSON.stringify(records, null, 2));
}

function dependencies(index: number): Array<{
  name: string;
  version: string;
  features: string[];
}> {
  return [
    {
      name: `utility-${index % 37}`,
      version: `${1 + (index % 4)}.${index % 13}.${index % 9}`,
      features: index % 2 === 0 ? ['std'] : [],
    },
    {
      name: index % 3 === 0 ? 'serde' : `codec-${index % 29}`,
      version: index % 3 === 0 ? '1.0.218' : `0.${index % 17}.${index % 23}`,
      features: index % 6 === 0 ? ['derive'] : ['std'],
    },
    {
      name: index % 5 === 0 ? 'tokio' : `runtime-${index % 31}`,
      version: index % 5 === 0 ? '1.46.0' : `2.${index % 11}.${index % 7}`,
      features: index % 10 === 0 ? ['rt-multi-thread'] : ['rt'],
    },
  ];
}

function packages(): void {
  const records = Array.from({ length: 54 }, (_, index) => ({
    packageId: `pkg-${String(index).padStart(4, '0')}`,
    workspace: `workspace-${index % 12}`,
    directDependencies: dependencies(index),
    private: index % 4 === 0,
  }));

  records[36] = {
    ...fixtureAt(records, 36),
    directDependencies: [
      { name: 'serde', version: '1.0.219', features: ['derive'] },
      { name: 'tokio', version: '1.46.0', features: ['rt'] },
    ],
  };
  records[37] = {
    ...fixtureAt(records, 37),
    directDependencies: [
      { name: 'serde', version: '1.0.219', features: ['derive'] },
      { name: 'tokio', version: '1.46.0', features: ['rt-multi-thread'] },
      { name: 'tracing-subscriber', version: '0.3.19', features: ['fmt'] },
    ],
  };
  records[38] = {
    ...fixtureAt(records, 38),
    directDependencies: [
      { name: 'serde', version: '1.0.218', features: ['derive'] },
      { name: 'tokio', version: '1.46.0', features: ['rt-multi-thread'] },
    ],
  };
  records[39] = {
    ...fixtureAt(records, 39),
    packageId: 'pkg-isolated-0219',
    directDependencies: [
      { name: 'serde', version: '1.0.219', features: ['std', 'derive'] },
      { name: 'tokio', version: '1.46.0', features: ['macros', 'rt-multi-thread'] },
      { name: 'tracing', version: '0.1.41', features: ['std'] },
    ],
  };

  console.log(JSON.stringify(records, null, 2));
}

function files(): void {
  const paths: string[] = [];
  for (let service = 0; service < 50; service += 1) {
    for (const generation of ['legacy', 'current', 'next']) {
      paths.push(`src/services/service-${String(service).padStart(2, '0')}/${generation}/serializer.ts`);
      paths.push(`src/services/service-${String(service).padStart(2, '0')}/${generation}/schema.json`);
      paths.push(`src/services/service-${String(service).padStart(2, '0')}/protocol/protocol-v${(service % 4) + 1}.json`);
    }
  }
  paths.push(
    'src/service/accounts/legacy/serializer.ts',
    'src/service/accounts/protocol/protocol-v2.json',
    'src/services/account/legacy/serializer.ts',
    'src/services/account/protocol/protocol-v2.json',
    'src/services/accounts/current/serializer.ts',
    'src/services/accounts/legacy/serializer.ts',
    'src/services/accounts/protocol/protocol-v3.json',
    'src/services/accounts-v2/legacy/serializer.ts',
    'src/services/accounts-v2/protocol/protocol-v1.json',
  );
  console.log(paths.toSorted().join('\n'));
}

switch (process.argv[2]) {
  case 'deployments':
    deployments();
    break;
  case 'packages':
    packages();
    break;
  case 'files':
    files();
    break;
  default:
    console.error('Usage: benchctl <deployments|packages|files>');
    process.exit(2);
}
