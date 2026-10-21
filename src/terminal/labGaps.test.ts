import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSession } from './testUtils.ts';

// Engine gaps found while writing lessons (DiskPart, AD, counts, filters, accounts ...)

test('DiskPart: free space, RAW partitions, list volume and detail disk', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  const before = run('list disk').stdout;
  assert.match(before, /\n {2}Disk 1 +Online +250 GB +250 GB/);
  assert.match(before, /\n {2}Disk 0 +Online +500 GB +0 B/);
  const vols = run('list volume').stdout;
  assert.match(vols, /^ {2}Volume ### {2}Ltr {2}Label/);
  assert.match(vols, /Volume 0 +C +Windows +NTFS +Partition +499 GB +Healthy +Boot/);

  run('select disk 1');
  assert.equal(run('list partition').stdout, 'There are no partitions on this disk to show.');
  assert.match(run('detail disk').stdout, /^Crucial CT250MX500SSD1\nDisk ID: [\s\S]*Boot Disk {2}: No[\s\S]*There are no volumes\.$/);

  run('create partition primary');
  const disk1 = run.state().disks.find(d => d.diskNumber === 1)!;
  assert.equal(disk1.partitions.length, 1, 'the free-space entry is replaced by the new partition');
  assert.deepEqual([disk1.partitions[0].sizeMB, disk1.partitions[0].fsType, disk1.partitions[0].isPrimary], [256000, 'Unallocated', true]);
  assert.match(run('list disk').stdout, /\* Disk 1 +Online +250 GB +0 B/);
  assert.match(run('list partition').stdout, /\* Partition 1 +Primary +250 GB +1024 KB/);
  assert.match(run('list volume').stdout, /\* Volume 2 +RAW +Partition +250 GB/);
  assert.match(run('create partition primary').stdout, /not enough usable space/);

  run('format fs=ntfs quick label=Data');
  run('assign letter=E');
  assert.match(run('list volume').stdout, /\* Volume 2 +E +Data +NTFS +Partition +250 GB +Healthy/);
  assert.match(run('detail disk').stdout, /Volume 2 +E +Data +NTFS/);
  assert.match(run('select volume c').stdout, /Volume 0 is the selected volume/);
  assert.equal(run.state().diskpartSelectedDisk, 0);
  assert.match(run('detail disk').stdout, /Boot Disk {2}: Yes/);
});

test('DiskPart: create partition primary size= leaves the rest free', () => {
  const run = windowsSession('cmd');
  run('diskpart');
  run('select disk 1');
  run('create partition primary size=102400');
  assert.match(run('list disk').stdout, /\* Disk 1 +Online +250 GB +150 GB/);
  run('create partition primary');
  assert.match(run('list partition').stdout, /Partition 2 +Primary +150 GB +100 GB/);
});
