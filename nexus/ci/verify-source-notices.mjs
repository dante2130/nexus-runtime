// SPDX-License-Identifier: MIT
// Local opt-in validation of the source notice manifests against an existing
// checkout tree. Read-only: it never writes, builds, downloads or initializes a
// submodule. It is not part of the source-only CI job, which has no runtime
// submodule content and only checks committed gitlinks, manifest schema and
// synthetic fixtures.
//
// Usage:
//   node nexus/ci/verify-source-notices.mjs --source /absolute/tree [--family nexus|nexus-cachyos] [--allow-blocked] [--manifest FILE]...
//
// The tree may be a superproject worktree with initialized submodules or a flat
// collection of standalone module checkouts at their repository-relative paths.
// Every discovered checkout must record the declared commit at HEAD; nested
// gitlinks are read from the git objects, so an absent nested checkout is still
// compared against its recorded pin. `--manifest` restricts the check to the
// named manifests, which lets a partial input tree verify only its own part
// without pretending the rest exists.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {project,run} from '../inputs.mjs';
import {loadNoticeManifests,noticeFamilies,sourceNoticePlan,variantNoticeManifest,verifyNoticePlan} from '../source-notices.mjs';

const maxDepth=12;
const git=(cwd,args)=>run('git',args,cwd,{capture:true}).trim();

async function exists(target){
  try{await fs.lstat(target);return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}

export async function checkoutInventory(source){
  const root=await fs.realpath(source),modules=new Map();
  const record=(relative,commit)=>{
    if(!relative)return;
    if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid recorded commit for '+relative);
    if(modules.has(relative)&&modules.get(relative)!==commit)throw Error('Conflicting recorded commit for '+relative);
    modules.set(relative,commit);
  };
  const scanRepo=async(directory,relative,expected)=>{
    const head=git(directory,['rev-parse','HEAD']);
    if(!/^[a-f0-9]{40}$/.test(head))throw Error('Invalid checkout commit in '+(relative||'.'));
    if(expected&&head!==expected)throw Error('Nested checkout does not match the recorded gitlink: '+relative);
    record(relative,head);
    for(const line of git(directory,['ls-tree','-r','HEAD']).split('\n')){
      if(!line.startsWith('160000 commit '))continue;
      const match=/^160000 commit ([a-f0-9]{40})\t(.+)$/.exec(line);
      if(!match)throw Error('Malformed gitlink listing entry in '+(relative||'.'));
      const child=relative?relative+'/'+match[2]:match[2],recorded=match[1];
      record(child,recorded);
      if(await exists(path.join(root,child,'.git')))await scanRepo(path.join(root,child),child,recorded);
    }
  };
  const descend=async(directory,relative,depth)=>{
    if(depth>maxDepth)throw Error('Source tree nesting is too deep at '+(relative||'.'));
    if(await exists(path.join(directory,'.git'))){await scanRepo(directory,relative,undefined);return;}
    let entries;
    try{entries=await fs.readdir(directory,{withFileTypes:true});}
    catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries.sort((left,right)=>left.name.localeCompare(right.name))){
      if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
      await descend(path.join(directory,entry.name),relative?relative+'/'+entry.name:entry.name,depth+1);
    }
  };
  await descend(root,'',0);
  if(!modules.size)throw Error('No checked-out source module was found under '+root);
  return [...modules].map(([modulePath,commit])=>({path:modulePath,commit})).sort((left,right)=>left.path.localeCompare(right.path));
}

async function main(argv){
  const options={source:undefined,family:undefined,manifests:[],allowBlocked:false};
  for(let index=0;index<argv.length;index++){
    const argument=argv[index];
    if(argument==='--allow-blocked'){options.allowBlocked=true;continue;}
    if(argument==='--source'||argument==='--family'||argument==='--manifest'){
      const value=argv[++index];
      if(!value||value.startsWith('--'))throw Error('Missing value for '+argument);
      if(argument==='--source')options.source=value;
      else if(argument==='--family')options.family=value;
      else options.manifests.push(value);
      continue;
    }
    throw Error('Usage: verify-source-notices.mjs --source TREE [--family nexus|nexus-cachyos] [--allow-blocked] [--manifest FILE]...');
  }
  if(!options.source)throw Error('Usage: verify-source-notices.mjs --source TREE [--family nexus|nexus-cachyos] [--allow-blocked] [--manifest FILE]...');
  const family=options.family??(await exists(path.join(project,'licenses',variantNoticeManifest))?'nexus-cachyos':'nexus');
  if(!noticeFamilies.includes(family))throw Error('Unknown family: '+family);
  const inventory=await checkoutInventory(options.source);
  const manifests=options.manifests.length
    ? await Promise.all(options.manifests.map(async file=>({file:path.basename(file),document:JSON.parse(await fs.readFile(file,'utf8'))})))
    : await loadNoticeManifests({project,family,inventory});
  const plan=sourceNoticePlan({manifests,inventory});
  const verified=await verifyNoticePlan({plan,sourceRoot:options.source,allowBlocked:true});
  const report={
    schema:1,
    kind:'source-notices-local-check',
    source:await fs.realpath(options.source),
    family,
    manifests:verified.plan.manifests,
    modules:verified.plan.modules.length,
    notices:verified.notices.map(({name,module,path:p,sha256})=>({name,module,path:p,sha256})),
    contextFiles:verified.contextFiles,
    externalSources:verified.externalSources,
    blocked:verified.plan.blockers.length>0,
    blockers:verified.plan.blockers,
  };
  console.log(JSON.stringify(report,null,2));
  if(report.blocked&&!options.allowBlocked)throw Error('Source notice inventory is blocked: '+report.blockers.join('; '));
  console.log('Verified '+report.notices.length+' notice file(s) and '+report.contextFiles.length+' context file(s) against the declared pins.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main(process.argv.slice(2));}
  catch(error){console.error('::error::'+error.message);process.exitCode=1;}
}
