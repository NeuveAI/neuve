import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const slowOutlineEngine = (root: string) => {
  const executable = join(root, "engine");
  const script = `#!${process.execPath}
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2),emit=x=>console.log(JSON.stringify(x));
if(args[0]==='version')emit({version:'fixture',provider:'entire-graph',identity_revision:'4',build_identity:createHash('sha256').update(readFileSync(import.meta.path)).digest('hex')});
else if(args[0]==='capabilities')emit({schema_version:'1.3',provider:'entire-graph',supported_file_extensions:['.ts'],supported_languages:['TypeScript'],semantic_languages:['TypeScript'],inventory_only_languages:[],supported_relation_types:['DEFINES','CONTAINS'],relation_support_by_language:{},relation_support_by_profile:{'syntax-only':['DEFINES','CONTAINS']},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:true},features_requiring_network_access:{}});
else {
 readFileSync(0);
 emit({schema_version:'1.3',provider:'entire-graph',provider_version:'fixture',identity_revision:'4',repo_root:args[args.indexOf('--repo')+1],profile:'syntax-only'});
 emit({record_type:'file_outline',file_path:'a.ts',language:'TypeScript',top_level:[],identifiers:[]});
 emit({record_type:'summary',partial_failures:[]});
}
`;
  writeFileSync(executable, script, { mode: 0o700 });
  const bytes = new TextEncoder().encode("export const a = 1;\n"),
    oid = createHash("sha1").update(bytes).digest("hex");
  return {
    source: {
      executable,
      key: { sha256: createHash("sha256").update(script).digest("hex") },
    },
    bytes,
    entry: {
      path: "a.ts",
      oid,
      size: bytes.length,
      type: "blob",
      mode: "100644",
    },
  };
};
