// Why: a ported Linguist rule that silently never fires, or fires on its neighbour, is the
// failure this port can have. Each rule gets inputs built from what `generated.rb` documents for
// it (its comments and the literals it tests): at least one that fires it and one near miss that
// does not. A rule that needs the bytes must say "not evaluated" without them, never false; the
// chain must report Linguist's first rule; and the same input must give the same mark.
import { expect, test } from "bun:test";
import {
  GENERATED_RULES,
  type GeneratedRuleName,
  LAZY_BLOB_MAX_SIZE,
  LINGUIST_STANDARD,
  linguistMark,
} from "../src/linguist/index.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const mark = (path: string, text?: string) =>
  linguistMark(path, text === undefined ? undefined : bytes(text));
const lines = (...rows: string[]) => rows.join("\n");

type Input = readonly [path: string, contents?: string];
const cases: readonly {
  rule: GeneratedRuleName;
  fires: readonly Input[];
  misses: readonly Input[];
}[] = [
  {
    rule: "xcode_file?",
    fires: [
      ["MainMenu.nib"],
      ["App.xcworkspace/contents.xcworkspacedata"],
      ["UserInterfaceState.xcuserstate"],
    ],
    misses: [["MainMenu.NIB"], ["MainMenu.xib"]],
  },
  {
    rule: "intellij_file?",
    fires: [[".idea/workspace.xml"], ["app/.idea/misc.xml"]],
    misses: [["my.idea/workspace.xml"], ["idea/workspace.xml"]],
  },
  {
    rule: "cocoapods?",
    fires: [["Pods/AFNetworking/AFURLSession.m"], ["ios/Pods/x.h"]],
    misses: [["MyPods/x.m"], ["Pods"]],
  },
  {
    rule: "carthage_build?",
    fires: [["Carthage/Build/iOS/Alamofire.framework/Alamofire"]],
    misses: [["Carthage/Checkouts/Alamofire/Source/Alamofire.swift"]],
  },
  {
    rule: "generated_graphql_relay?",
    fires: [["src/__generated__/AppQuery.graphql.js"]],
    misses: [["src/__generated/AppQuery.js"]],
  },
  {
    rule: "generated_net_designer_file?",
    fires: [
      ["Form1.Designer.cs"],
      ["Resources.designer.vb"],
      ["FORM1.DESIGNER.CS"],
    ],
    misses: [["Form1.Designer.fs"], ["Form1.cs"]],
  },
  {
    rule: "generated_net_specflow_feature_file?",
    fires: [["Login.feature.cs"], ["Login.Feature.CS"]],
    misses: [["Login.feature"], ["Login.feature.vb"]],
  },
  {
    rule: "composer_lock?",
    fires: [["composer.lock"]],
    misses: [["composer.json"]],
  },
  {
    rule: "cargo_lock?",
    fires: [["Cargo.lock"]],
    misses: [["cargo.lock"], ["Cargo.toml"]],
  },
  {
    rule: "cargo_orig?",
    fires: [["Cargo.toml.orig"]],
    misses: [["Cargo.toml"]],
  },
  { rule: "deno_lock?", fires: [["deno.lock"]], misses: [["deno.json"]] },
  {
    rule: "flake_lock?",
    fires: [["flake.lock"], ["nix/flake.lock"]],
    misses: [["myflake.lock"], ["flake.lock.bak"]],
  },
  {
    rule: "bazel_lock?",
    fires: [["MODULE.bazel.lock"]],
    misses: [["MODULE.bazel"], ["XMODULE.bazel.lock"]],
  },
  {
    rule: "node_modules?",
    fires: [["node_modules/left-pad/index.js"], ["web/node_modules/x"]],
    misses: [["node_module/x.js"]],
  },
  {
    rule: "go_vendor?",
    fires: [
      ["vendor/github.com/pkg/errors/errors.go"],
      ["vendor/gopkg.in/yaml.v2/yaml.go"],
    ],
    misses: [["vendor/github-.com/x.go"], ["vendor/localhost/x.go"]],
  },
  {
    rule: "go_lock?",
    fires: [["Gopkg.lock"], ["glide.lock"]],
    misses: [["Gopkg.toml"]],
  },
  {
    rule: "package_resolved?",
    fires: [["Package.resolved"]],
    misses: [["package.resolved"]],
  },
  { rule: "poetry_lock?", fires: [["poetry.lock"]], misses: [["poetry.toml"]] },
  { rule: "pdm_lock?", fires: [["pdm.lock"]], misses: [["pdm.toml"]] },
  { rule: "uv_lock?", fires: [["uv.lock"]], misses: [["uv.toml"]] },
  { rule: "pixi_lock?", fires: [["pixi.lock"]], misses: [["pixi.toml"]] },
  {
    rule: "esy_lock?",
    fires: [["esy.lock"], ["app/name.esy.lock"]],
    misses: [["myesy.lock"], ["esy.lock.json"]],
  },
  {
    rule: "npm_shrinkwrap_or_package_lock?",
    fires: [["npm-shrinkwrap.json"], ["package-lock.json"]],
    misses: [["package.json"]],
  },
  {
    rule: "pnpm_lock?",
    fires: [["pnpm-lock.yaml"]],
    misses: [["pnpm-workspace.yaml"]],
  },
  {
    rule: "bun_lock?",
    fires: [["bun.lock"], ["bun.lockb"]],
    misses: [["bun.lockfile"], ["mybun.lock"]],
  },
  {
    rule: "terraform_lock?",
    fires: [[".terraform.lock.hcl"]],
    misses: [["terraform.lock.hcl"]],
  },
  {
    rule: "generated_yarn_plugnplay?",
    fires: [[".pnp.cjs"], [".pnp.loader.mjs"]],
    misses: [["pnp.cjs"]],
  },
  {
    rule: "godeps?",
    fires: [["Godeps/Godeps.json"]],
    misses: [["godeps/x.json"]],
  },
  {
    rule: "generated_by_zephir?",
    fires: [["ext/kernel/main.zep.c"], ["a.zep.php"]],
    misses: [[".zep.c"], ["a.zep.cpp"]],
  },
  {
    rule: "htmlcov?",
    fires: [["htmlcov/index.html"]],
    misses: [["myhtmlcov/index.html"]],
  },
  {
    rule: "minified_files?",
    // Average line length above 110: Ruby divides integers, and counts bytes.
    fires: [
      ["app.min.js", "a".repeat(111)],
      ["style.CSS", "é".repeat(56)],
    ],
    misses: [
      ["app.js", lines("a".repeat(111), "a".repeat(110))],
      ["app.ts", "a".repeat(500)],
      ["app.js", ""],
    ],
  },
  {
    rule: "has_source_map?",
    fires: [
      ["app.js", lines("var a;", "//# sourceMappingURL=app.js.map", "")],
      ["app.css", lines("a{}", "/*@ sourceURL=app.css")],
    ],
    misses: [
      ["app.js", lines("//# sourceMappingURL=app.js.map", "var a;", "")],
      ["app.ts", "//# sourceMappingURL=app.js.map"],
    ],
  },
  {
    rule: "source_map?",
    fires: [
      ["app.js.map"],
      ["app.CSS.map"],
      ["out.map", '{"version":3,"sources":[]}'],
      ["out.map", "/** Begin line maps. **/{"],
    ],
    misses: [["out.map", '{ "version": 3 }'], ["app.js.mapx"]],
  },
  {
    rule: "compiled_coffeescript?",
    fires: [
      ["app.js", lines("// Generated by CoffeeScript 1.12.7", "(function() {")],
      [
        "app.js",
        lines("(function() {", "  var _i, _len, _ref;", "}).call(this);", ""),
      ],
      [
        "app.js",
        lines("(function() {", "  var __bind = 1;", "}).call(this);", ""),
      ],
    ],
    misses: [
      [
        "app.js",
        lines("(function() {", "  var _i, _len;", "}).call(this);", ""),
      ],
      [
        "app.js",
        lines("(function() {", "  var _i, _len, _ref;", "}).call(this);"),
      ],
      // The last line is blank but the closure does not close on the line before it.
      ["app.js", lines("(function() {", "  var _i, _len, _ref;", "})();", "")],
      // The closure closes on the second-to-last line, but the last line is not blank.
      [
        "app.js",
        lines("(function() {", "  var _i, _len, _ref;", "}).call(this);", "x"),
      ],
      ["app.JS", lines("// Generated by CoffeeScript 1.12.7")],
    ],
  },
  {
    rule: "generated_parser?",
    fires: [
      ["parser.js", lines("/*", " * Generated by PEG.js 0.10.0.", " */")],
      // Ruby joins the first five lines with nothing between them, so "/" and "*" meet.
      ["parser.js", lines("/", "* Generated by PEG.js 0.10.0 */")],
    ],
    misses: [
      ["parser.js", lines("/* parser */", "// Generated by PEG.js")],
      ["parser.js", lines("", "", "", "", "", "/* Generated by PEG.js */")],
    ],
  },
  {
    rule: "generated_net_docfile?",
    fires: [
      [
        "MyLib.XML",
        lines(
          '<?xml version="1.0"?>',
          "<doc>",
          "    <assembly>",
          "        <name>MyLib</name>",
          "</doc>",
          "",
        ),
      ],
    ],
    misses: [
      [
        "MyLib.xml",
        lines(
          '<?xml version="1.0"?>',
          "<doc>",
          "    <assembly>",
          "        <name>MyLib</name>",
          "</doc>",
        ),
      ],
      ["MyLib.xml", lines("<doc>", "<assembly>", "</doc>")],
    ],
  },
  {
    rule: "generated_postscript?",
    fires: [
      [
        "font.pfa",
        lines(
          "%!PS-AdobeFont-1.0: Foo",
          "  currentfile eexec",
          "D9D66F633B846A97",
        ),
      ],
      ["font.ps", lines("%!PS", "/sfnts [ <0001>")],
      [
        "fig.eps",
        lines("%!PS-Adobe-3.0 EPSF-3.0", "%%Creator: dvips(k) 5.996"),
      ],
      ["fig.eps", lines("%!PS-Adobe-3.0", "%%Creator: inkscape")],
      [
        "board.ps",
        lines("%!PS", "%%Creator: EAGLE", "%%Title: EAGLE Drawing board.brd"),
      ],
    ],
    misses: [
      ["fig.eps", lines("%!PS-Adobe-3.0", "%%Creator: John Smith")],
      ["board.ps", lines("%!PS", "%%Creator: EAGLE", "%%Title: board")],
      ["fig.EPS", lines("%!PS", "%%Creator: dvips 5")],
    ],
  },
  {
    rule: "compiled_cython_file?",
    fires: [
      [
        "mod.c",
        lines("/* Generated by Cython 0.29.21 */", "#include <Python.h>"),
      ],
    ],
    misses: [
      ["mod.c", "/* Generated by Cython 0.29.21 */"],
      ["mod.h", lines("/* Generated by Cython 0.29.21 */", "")],
    ],
  },
  { rule: "pipenv_lock?", fires: [["Pipfile.lock"]], misses: [["Pipfile"]] },
  {
    rule: "gradle_wrapper?",
    fires: [["gradlew"], ["app/GRADLEW.BAT"]],
    misses: [["gradlew.sh"], ["mygradlew"]],
  },
  {
    rule: "maven_wrapper?",
    fires: [["mvnw"], ["mvnw.cmd"]],
    misses: [["mvnw.bat"]],
  },
  {
    rule: "mise_lock?",
    fires: [["mise.lock"], ["mise.local.lock"]],
    misses: [["mise.toml"], ["mise.a/b.lock"]],
  },
  {
    rule: "secrets_baseline?",
    fires: [[".secrets.baseline"]],
    misses: [["secrets.baseline"]],
  },
  {
    rule: "julia_manifest?",
    fires: [["Manifest.toml"], ["JuliaManifest-v1.11.toml"]],
    misses: [["Manifest-v1.toml"], ["manifest.toml"]],
  },
  {
    rule: "generated_go?",
    fires: [
      [
        "api.pb.go",
        lines(
          "// Code generated by protoc-gen-go. DO NOT EDIT.",
          "package api",
        ),
      ],
    ],
    misses: [
      [
        "api.go",
        lines(...Array(40).fill("//"), "// Code generated by x. DO NOT EDIT."),
      ],
      ["api.go", "// Code generated by protoc-gen-go. DO NOT EDIT."],
      ["api.go", lines("//Code generated by x", "")],
    ],
  },
  {
    rule: "generated_protocol_buffer_from_go?",
    fires: [
      [
        "generated.proto",
        lines(
          "// This file was autogenerated by go-to-protobuf. Do not edit it manually!",
          "syntax = 'proto2';",
        ),
      ],
    ],
    misses: [
      [
        "generated.proto",
        lines(
          ...Array(20).fill(""),
          "// This file was autogenerated by go-to-protobuf.",
        ),
      ],
    ],
  },
  {
    rule: "generated_protocol_buffer?",
    fires: [
      [
        "a_pb2.py",
        lines(
          "# Generated by the protocol buffer compiler.  DO NOT EDIT!",
          "# source: a.proto",
        ),
      ],
    ],
    misses: [
      [
        "a_pb2.py",
        lines("# Generated by the protocol buffer compiler. DO NOT EDIT!", ""),
      ],
      [
        "a.pb.go",
        lines("# Generated by the protocol buffer compiler.  DO NOT EDIT!", ""),
      ],
    ],
  },
  {
    rule: "generated_javascript_protocol_buffer?",
    fires: [
      [
        "a_pb.js",
        lines(
          "/**",
          " * @fileoverview",
          " * @enhanceable",
          " * @public",
          " */",
          "// GENERATED CODE -- DO NOT EDIT!",
          "",
        ),
      ],
    ],
    misses: [
      [
        "a_pb.js",
        lines(
          "/**",
          " * @fileoverview",
          " * @public",
          " */",
          "// GENERATED CODE -- DO NOT EDIT!",
          "",
          "",
        ),
      ],
    ],
  },
  {
    rule: "generated_typescript_protocol_buffer?",
    fires: [
      [
        "hello.ts",
        lines(
          "// Code generated by protoc-gen-ts_proto. DO NOT EDIT.",
          "// versions:",
          "//   protoc-gen-ts_proto  v1.181.2",
          "//   protoc               v5.28.2",
          "// source: hello.proto",
          "",
          "/* eslint-disable */",
        ),
      ],
    ],
    misses: [
      [
        "hello.ts",
        lines(
          "// Code generated by protoc-gen-ts_proto. DO NOT EDIT.",
          "// source: hello.proto",
          "",
          "",
        ),
      ],
    ],
  },
  {
    rule: "generated_twirp_ruby?",
    fires: [
      [
        "service_twirp.rb",
        lines(
          "# Code generated by protoc-gen-twirp_ruby 1.14.1, DO NOT EDIT.",
          "require 'twirp'",
        ),
      ],
    ],
    misses: [
      [
        "service_twirp.rb",
        lines(
          "# Code generated by protoc-gen-twirp_ruby 1.14.1",
          "# DO NOT EDIT.",
        ),
      ],
    ],
  },
  {
    rule: "generated_apache_thrift?",
    fires: [
      ["ttypes.py", lines("#", "# Autogenerated by Thrift Compiler (0.9.1)")],
      ["gen.go", "// Autogenerated by Thrift Compiler (0.13.0)"],
    ],
    misses: [
      [
        "ttypes.py",
        lines(
          ...Array(6).fill("#"),
          "# Autogenerated by Thrift Compiler (0.9.1)",
        ),
      ],
      ["gen.swift", "// Autogenerated by Thrift Compiler (0.13.0)"],
    ],
  },
  {
    rule: "generated_jni_header?",
    fires: [
      [
        "com_x_Y.h",
        lines(
          "/* DO NOT EDIT THIS FILE - it is machine generated */",
          "#include <jni.h>",
          "",
        ),
      ],
    ],
    misses: [
      [
        "com_x_Y.h",
        lines(
          "/* DO NOT EDIT THIS FILE - it is machine generated */",
          "#include <jni.h>",
        ),
      ],
    ],
  },
  {
    rule: "vcr_cassette?",
    fires: [
      [
        "cassette.yml",
        lines("---", "http_interactions: []", "recorded_with: VCR 6.0.0", ""),
      ],
    ],
    misses: [
      [
        "cassette.yml",
        lines("---", "http_interactions: []", "recorded_with: VCR 6.0.0"),
      ],
      ["cassette.yaml", lines("---", "x: 1", "recorded_with: VCR 6.0.0", "")],
    ],
  },
  {
    rule: "generated_antlr?",
    fires: [["T.g", lines("// $ANTLR", "// generated by Xtest", "grammar T;")]],
    misses: [
      ["T.g", lines("// generated by Xtest", "// $ANTLR", "grammar T;")],
    ],
  },
  {
    rule: "generated_module?",
    fires: [
      [
        "lib.mod",
        lines("PCBNEW-LibModule-V1  2012-01-01 0:00:00 AM", "$INDEX"),
      ],
      ["m.mod", lines("GFORTRAN module version '15' created from m.f90", "")],
    ],
    misses: [
      ["m.mod", lines("GFORTRAN module version 15 created from m.f90", "")],
      ["go.mod", lines("module example.com/x", "")],
    ],
  },
  {
    rule: "generated_unity3d_meta?",
    fires: [
      [
        "Player.cs.meta",
        lines("fileFormatVersion: 2", "guid: 0123456789abcdef"),
      ],
    ],
    misses: [
      [
        "Player.cs.meta",
        lines("fileFormatVersion:2", "guid: 0123456789abcdef"),
      ],
    ],
  },
  {
    rule: "generated_racc?",
    fires: [
      [
        "parser.rb",
        lines(
          "#",
          "# DO NOT MODIFY!!!!",
          "# This file is automatically generated by Racc 1.4.16",
          "",
        ),
      ],
    ],
    misses: [
      [
        "parser.rb",
        lines("#", "# This file is automatically generated by Racc 1.4.16", ""),
      ],
    ],
  },
  {
    rule: "generated_jflex?",
    fires: [
      [
        "Lexer.java",
        lines(
          "/* The following code was generated by JFlex 1.7.0 */",
          "",
          "package x;",
        ),
      ],
    ],
    misses: [
      [
        "Lexer.java",
        lines(" /* The following code was generated by JFlex 1.7.0 */", ""),
      ],
    ],
  },
  {
    rule: "generated_grammarkit?",
    fires: [
      [
        "Parser.java",
        lines(
          "// This is a generated file. Not intended for manual editing.",
          "package x;",
        ),
      ],
    ],
    misses: [
      ["Parser.java", lines("// This is a generated file.", "package x;")],
    ],
  },
  {
    rule: "generated_roxygen2?",
    fires: [
      [
        "man/f.Rd",
        lines(
          "% Generated by roxygen2: do not edit by hand",
          "% Please edit documentation in R/f.R",
        ),
      ],
    ],
    misses: [
      ["man/f.rd", lines("% Generated by roxygen2: do not edit by hand", "")],
    ],
  },
  {
    rule: "generated_html?",
    fires: [
      [
        "index.html",
        lines(
          "<!DOCTYPE html>",
          "<!-- Generated by pkgdown: do not edit by hand -->",
        ),
      ],
      [
        "ls.1.html",
        lines(
          "<!DOCTYPE html>",
          "<html>",
          "<!-- This is an automatically generated file.  Do not edit.",
        ),
      ],
      ["a.HTM", lines("<html>", "<!-- Generated by Doxygen 1.8.17 -->")],
      [
        "a.xhtml",
        lines(
          "<html>",
          "<head>",
          '<meta name="generator" content="ronn/v0.7.3" />',
        ),
      ],
      [
        "a.html",
        lines("<html>", "<meta NAME='Generator' CONTENT='Org Mode' >"),
      ],
      [
        "a.html",
        lines("<html>", '<meta name="generator" value="LaTeX2HTML 2008">'),
      ],
      ["a.html", lines("<html>", "<meta content=texi2html name=generator/>")],
    ],
    misses: [
      [
        "a.html",
        lines("<html>", '<meta name="generator" content="Hugo 0.92" />'),
      ],
      ["a.html", lines("<html>", '<meta name="description" content="ronn">')],
      ["a.html", lines("<html>", "<meta name=generator name=x content=ronn>")],
      ["a.html", '<meta name="generator" content="ronn">'],
      [
        "a.html",
        lines(
          "<html>",
          "<html>",
          "<html>",
          ...Array(28).fill(""),
          '<meta name="generator" content="ronn">',
        ),
      ],
    ],
  },
  {
    rule: "generated_jison?",
    fires: [
      ["parser.js", lines("/* parser generated by jison 0.4.18 */", "")],
      ["lexer.js", lines("/* generated by jison-lex 0.3.4 */", "")],
    ],
    misses: [
      ["parser.js", lines("/* parser generated by jison-lex 0.3.4 */", "")],
    ],
  },
  {
    rule: "generated_grpc_cpp?",
    fires: [
      [
        "a.grpc.pb.h",
        lines(
          "// Generated by the gRPC C++ plugin.",
          "// If you make any local change, they will be lost.",
        ),
      ],
    ],
    misses: [
      ["a.grpc.pb.hh", lines("// Generated by the gRPC C++ plugin.", "")],
    ],
  },
  {
    rule: "generated_dart?",
    fires: [
      ["a.pb.dart", lines("///", "//  Generated code. Do not modify.")],
      ["a.g.dart", lines("// GENERATED CODE - DO NOT MODIFY BY HAND", "")],
    ],
    misses: [
      ["a.g.dart", lines("// generated code do not modify", "")],
      [
        "a.g.dart",
        lines("", "", "", "// GENERATED CODE - DO NOT MODIFY BY HAND"),
      ],
    ],
  },
  {
    rule: "generated_perl_ppport_header?",
    fires: [
      [
        "ppport.h",
        lines(
          ...Array(8).fill("/*"),
          "    Automatically created by Devel::PPPort running under perl 5.030000.",
          "",
          "",
        ),
      ],
    ],
    misses: [
      [
        "ppport.h",
        lines(
          ...Array(8).fill("/*"),
          "    Automatically created by Devel::PPPort running under perl 5.030000.",
          "",
        ),
      ],
      [
        "ppport.hpp",
        lines(
          ...Array(8).fill("/*"),
          "    Automatically created by Devel::PPPort",
          "",
          "",
        ),
      ],
    ],
  },
  {
    rule: "generated_gamemakerstudio?",
    fires: [
      ["obj.yy", lines("{", '  "x": 1,', '  "y": 2', "}", "")],
      ["proj.yyp", lines('1.4.1804|{ "a": 1 }', "x", "y", "")],
    ],
    misses: [
      ["obj.yy", lines("{", "}", "")],
      ["obj.yy", lines("name: x", "a", "b", "")],
    ],
  },
  {
    rule: "generated_gimp?",
    fires: [
      [
        "image.c",
        lines(
          "/* GIMP RGB C-Source image dump (image.c) */",
          "",
          "static const struct {",
        ),
      ],
      ["image.h", "/*  GIMP header image file format (RGB): image.h  */"],
    ],
    misses: [
      ["image.c", lines("/* GIMP RGB C-Source image dump (image.h) */", "")],
      ["image.h", "/* GIMP header image file format (RGB): image.h */"],
    ],
  },
  {
    rule: "generated_visualstudio6?",
    fires: [
      [
        "proj.DSP",
        lines(
          "# Microsoft Developer Studio Project File",
          "# Microsoft Developer Studio Generated Build File, Format Version 6.00",
        ),
      ],
    ],
    misses: [
      [
        "proj.dsp",
        lines(
          "#",
          "#",
          "#",
          "# Microsoft Developer Studio Generated Build File",
        ),
      ],
    ],
  },
  {
    rule: "generated_haxe?",
    fires: [
      ["Main.cs", lines("// Generated by Haxe 4.2.5", "using System;")],
      ["main.lua", "-- Generated by Haxe 4.2.5"],
    ],
    misses: [
      ["Main.CS", lines("// Generated by Haxe 4.2.5", "")],
      ["main.lua", lines("", "", "", "-- Generated by Haxe 4.2.5")],
    ],
  },
  {
    rule: "generated_jooq?",
    fires: [
      ["Tables.JAVA", lines("/*", " * This file is generated by jOOQ.", " */")],
    ],
    misses: [
      ["Tables.java", lines("/*", " *", " * This file is generated by jOOQ.")],
    ],
  },
  {
    rule: "generated_pascal_tlb?",
    fires: [["Office_TLB.pas"], ["office_tlb.PAS"]],
    misses: [["Office_TLB.pp"], ["OfficeTLB.pas"]],
  },
  {
    rule: "generated_sorbet_rbi?",
    fires: [
      [
        "sorbet/rbi/gems/x.rbi",
        lines(
          "# typed: true",
          "",
          "# DO NOT EDIT MANUALLY",
          "# This is an autogenerated file for types exported from the `x` gem.",
          "# Please instead update this file by running `bin/tapioca gem x`.",
        ),
      ],
    ],
    misses: [
      [
        "sorbet/rbi/gems/x.rbi",
        lines(
          "# typed: true",
          "",
          "# DO NOT EDIT MANUALLY",
          "#",
          "# Please run `tapioca gem x`.",
        ),
      ],
      [
        "x.rbi",
        lines(
          "# typed: true",
          "",
          "# DO NOT EDIT MANUALLY",
          "# Please run `bin/tapioca dsl`.",
        ),
      ],
    ],
  },
  {
    rule: "generated_mysql_view_definition_format?",
    fires: [
      ["db/v.frm", lines("TYPE=VIEW", "query=select 1")],
      ["V.FRM", "TYPE=VIEW"],
    ],
    misses: [["db/t.frm", lines("TYPE=BASE TABLE", "")]],
  },
  {
    rule: "generated_sqlx_query?",
    fires: [[`.sqlx/query-${"0123456789abcdef".repeat(4)}.json`]],
    misses: [
      [`.sqlx/query-${"0123456789abcdef".repeat(4).slice(1)}.json`],
      [`.sqlx/query-${"0123456789ABCDEF".repeat(4)}.json`],
    ],
  },
];

test("every generated rule has its own cases, in Linguist's order", () => {
  expect(cases.map((c) => c.rule)).toEqual(
    GENERATED_RULES.map((rule) => rule.name),
  );
});

for (const { rule, fires, misses } of cases)
  test(`${rule} fires on its documented forms and not on its near misses`, () => {
    for (const [path, contents] of fires)
      expect({
        path,
        contents,
        rule: mark(path, contents).generated?.rule,
      }).toEqual({ path, contents, rule });
    for (const [path, contents] of misses)
      expect({
        path,
        contents,
        generated: mark(path, contents).generated,
      }).toEqual({ path, contents, generated: null });
  });

test("a rule that needs the bytes is not evaluated without them, never false", () => {
  const contentRules = cases.filter(({ fires }) =>
    fires.some(([, contents]) => contents !== undefined),
  );
  expect(contentRules.length).toBe(36);
  for (const { rule, fires } of contentRules) {
    const [path] = fires.find(([, contents]) => contents !== undefined)!;
    const result = mark(path);
    expect({
      rule,
      generated: result.generated,
      listed: result.notEvaluated.includes(rule),
    }).toEqual({ rule, generated: null, listed: true });
  }
  // Every content rule a JavaScript file reaches, in order; none for a path no content rule reads.
  expect(mark("lib/app.js").notEvaluated).toEqual([
    "minified_files?",
    "has_source_map?",
    "compiled_coffeescript?",
    "generated_parser?",
    "generated_javascript_protocol_buffer?",
    "generated_apache_thrift?",
    "generated_jison?",
    "generated_haxe?",
  ]);
  expect(mark("README.md").notEvaluated).toEqual([]);
  // A content rule whose path test settles it needs no bytes.
  expect(mark("app.js.map")).toMatchObject({
    generated: { rule: "source_map?" },
    notEvaluated: [],
  });
  // With bytes given, nothing is left unevaluated.
  expect(mark("lib/app.js", "var a = 1;\n").notEvaluated).toEqual([]);
});

test("where Linguist itself gives no answer, the rule is not evaluated and the chain stops", () => {
  // `lines[0].include?` on an empty .frm file: lines is [], and Ruby raises NoMethodError.
  expect(mark("db/v.frm", "")).toMatchObject({
    generated: null,
    notEvaluated: ["generated_mysql_view_definition_format?"],
  });
  // A meta tag whose attributes follow a NUL byte: Ruby 2.6's strip keeps a leading NUL, later
  // Rubies drop it, and the two readings disagree.
  expect(
    mark("a.html", lines("<html>", '<meta \0name="generator" content="ronn">')),
  ).toMatchObject({
    generated: null,
    notEvaluated: ["generated_html?"],
  });
  expect(
    mark("a.html", lines("<html>", '<meta \0name="generator" content="Hugo">')),
  ).toMatchObject({
    generated: null,
    notEvaluated: [],
  });
});

test("an input two rules match reports Linguist's first", () => {
  expect(mark("node_modules/x/Cargo.lock").generated).toEqual({
    rule: "cargo_lock?",
  });
  expect(mark("Pods/x/package-lock.json").generated).toEqual({
    rule: "cocoapods?",
  });
  // A minified file named like a Pipfile lock: minified_files? comes first.
  expect(mark("Pipfile.lock.js", "a".repeat(200)).generated).toEqual({
    rule: "minified_files?",
  });
  // Without the bytes the file is still generated, by the later path rule, and the earlier
  // content rules that might have come first are listed.
  expect(mark("Pipfile.lock.js")).toMatchObject({
    generated: { rule: "pipenv_lock?" },
    notEvaluated: [
      "minified_files?",
      "has_source_map?",
      "compiled_coffeescript?",
      "generated_parser?",
    ],
  });
  // A protobuf JavaScript file that is also minified.
  expect(
    mark("a_pb.js", lines("// GENERATED CODE -- DO NOT EDIT!", "a".repeat(400)))
      .generated,
  ).toEqual({ rule: "minified_files?" });
});

test("the vendored pattern is the first that matches, as Linguist wrote it", () => {
  expect(mark("node_modules/x/index.js").vendored).toEqual({
    pattern: "(^|/)node_modules/",
  });
  expect(mark("dist/jquery.min.js").vendored).toEqual({
    pattern: "(^|/)dist/",
  });
  expect(mark("lib/jquery.min.js").vendored).toEqual({
    pattern: String.raw`(\.|-)min\.(js|css)$`,
  });
  expect(mark("types/index.d.ts").vendored).toEqual({
    pattern: String.raw`(.*?)\.d\.ts$`,
  });
  expect(mark(".github/workflows/ci.yml").vendored).toEqual({
    pattern: "(^|/)\\.github/",
  });
  expect(mark("src/index.ts").vendored).toBeNull();
  expect(mark("mydeps/x.c").vendored).toBeNull();
});

test("the same input gives the same mark, and letter case follows Linguist's own case rules", () => {
  const input = bytes(
    lines("// Code generated by protoc-gen-go. DO NOT EDIT.", "package api"),
  );
  const first = linguistMark("vendor/github.com/a/api.pb.go", input);
  linguistMark("other.js", bytes("x"));
  expect(linguistMark("vendor/github.com/a/api.pb.go", input)).toEqual(first);
  expect(first.standard).toMatchObject({
    name: "github-linguist",
    version: "v9.7.0",
    commit: "e0c78d62c42abae6122235d8e68a7aa43eef89da",
  });
  // Case-sensitive path tests, /i path tests, `extname` compared as is, `extname.downcase`.
  expect(mark("CARGO.LOCK").generated).toBeNull();
  expect(mark("FORM1.DESIGNER.CS").generated).toEqual({
    rule: "generated_net_designer_file?",
  });
  expect(
    mark("a.JS", "// Generated by CoffeeScript 1.12.7").generated,
  ).toBeNull();
  expect(mark("A.JS", "a".repeat(200)).generated).toEqual({
    rule: "minified_files?",
  });
  expect(mark("VENDOR/x.c").vendored).toBeNull();
  expect(mark("Vendor/x.c").vendored).toEqual({ pattern: "(^|/)[Vv]+endor/" });
});

test("the bytes are read as Linguist's byte string: no decoding, no failure on invalid UTF-8", () => {
  // 0xFF and a lone continuation byte are not UTF-8; Ruby's byte string does not care.
  const invalid = new Uint8Array([
    0xff,
    0x80,
    0x0a,
    ...bytes("// Code generated by x. DO NOT EDIT."),
  ]);
  expect(linguistMark("a.go", invalid).generated).toEqual({
    rule: "generated_go?",
  });
  // Ruby's `.` matches a carriage return; the PEG.js marker's `PEG.js` has one.
  expect(mark("p.js", "/* Generated by PEG\rjs */").generated).toEqual({
    rule: "generated_parser?",
  });
  // Ruby's `^` matches after every line feed in the whole data.
  expect(
    mark("f.ps", lines("%!PS", "% x", "   currentfile eexec", "")).generated,
  ).toEqual({ rule: "generated_postscript?" });
});

test("a path Ruby refuses is refused", () => {
  expect(() => linguistMark("a\0.js")).toThrow();
  expect(() => linguistMark("a\uD800.js")).toThrow();
  expect(linguistMark("a\u{1F600}.js").generated).toBeNull();
});

// Short lines of `line`, exactly `n` bytes, ending in a line feed.
const fill = (n: number, line = "var a;") =>
  `${`${line}\n`.repeat(Math.ceil(n / (line.length + 1))).slice(0, n - 1)}\n`;
const CAP = LAZY_BLOB_MAX_SIZE;
const SOURCE_MAP = "//# sourceMappingURL=app.js.map";

test("above the Git reader's cap, a rule whose two views disagree gives no mark and is not evaluated", () => {
  // Why: Linguist's Git reader hands the rules only the first 131,072 bytes; its file reader the
  // whole file. A file must not skip its readings on a mark the Git reader would not give, nor
  // on one the file reader would not give. Each blob here has its marker only past the cap.
  expect(CAP).toBe(131072);
  expect(LINGUIST_STANDARD.reader).toBe("both views agree above 131072 bytes");
  const disagreeing: [GeneratedRuleName, string, string][] = [
    ["has_source_map?", "app.js", `${fill(200_000)}${SOURCE_MAP}\n`],
    [
      "vcr_cassette?",
      "cassette.yml",
      `---\n${fill(200_000)}recorded_with: VCR 6.0.0\n`,
    ],
    [
      "generated_net_docfile?",
      "MyLib.xml",
      `<?xml version="1.0"?>\n<doc>\n<assembly>\n${fill(200_000)}</doc>\n`,
    ],
    [
      "generated_postscript?",
      "font.ps",
      `%!PS\n${fill(200_000)}currentfile eexec\nD9D6\n`,
    ],
    [
      "minified_files?",
      "app.js",
      `${fill(CAP + 10_000, "a".repeat(99))}${`${"b".repeat(1000)}\n`.repeat(200)}`,
    ],
  ];
  for (const [rule, path, contents] of disagreeing) {
    expect(contents.length).toBeGreaterThan(CAP);
    expect({ rule, ...mark(path, contents) }).toMatchObject({
      rule,
      generated: null,
      notEvaluated: [rule],
    });
  }
  // The chain goes on past the unanswered rule, as for any unanswered rule.
  const minified = disagreeing.find(([rule]) => rule === "minified_files?")![2];
  expect(mark("Pipfile.lock.js", minified)).toMatchObject({
    generated: { rule: "pipenv_lock?" },
    notEvaluated: ["minified_files?"],
  });
});

test("above the cap, a rule both views agree on gives its mark", () => {
  // Why: the two-view rule must cost a reading only where the readers differ, not on every
  // large file.
  // A long minified file: long lines in the head and to the end.
  expect(mark("app.js", `${"a".repeat(500)}\n`.repeat(400))).toMatchObject({
    generated: { rule: "minified_files?" },
    notEvaluated: [],
  });
  // A source-map reference ending the first 131,072 bytes, and the same at the real end.
  const head = `${fill(CAP - SOURCE_MAP.length - 1)}${SOURCE_MAP}\n`;
  expect(head.length).toBe(CAP);
  expect(mark("app.js", `${head}${fill(70_000)}${SOURCE_MAP}\n`)).toMatchObject(
    {
      generated: { rule: "has_source_map?" },
      notEvaluated: [],
    },
  );
  // A font stream in the head.
  expect(
    mark("font.ps", `%!PS\ncurrentfile eexec\n${fill(200_000)}`),
  ).toMatchObject({
    generated: { rule: "generated_postscript?" },
    notEvaluated: [],
  });
});

test("at or under the cap a blob is read once, as before", () => {
  // Why: the two views are the same bytes there, so nothing may change.
  const under = `${fill(CAP - 100)}${SOURCE_MAP}\n`;
  expect(under.length).toBeLessThan(CAP);
  expect(mark("app.js", under).generated).toEqual({ rule: "has_source_map?" });
  const at = `${fill(CAP - SOURCE_MAP.length - 1)}${SOURCE_MAP}\n`;
  expect(at.length).toBe(CAP);
  expect(mark("app.js", at).generated).toEqual({ rule: "has_source_map?" });
  const cassette = `---\n${fill(CAP - 100)}recorded_with: VCR 6.0.0\n`;
  expect(cassette.length).toBeLessThanOrEqual(CAP);
  expect(mark("cassette.yml", cassette).generated).toEqual({
    rule: "vcr_cassette?",
  });
});
