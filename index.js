let NodeNuget;
const fs = require('fs');
const path = require('path');
const _ = require('underscore');
const Queue = require('queue-async');
const es = require('event-stream');
const et = require('elementtree');
const crypto = require('crypto');
const vinyl = require('vinyl-fs');

require('shelljs/global');
const NUGET_EXE = path.resolve(path.join(__dirname, './bin/NuGet.exe'));

const runCommand = function(command, arg_or_args) {
  let args = [NUGET_EXE, command];
  args = args.concat((_.isArray(arg_or_args)) ? arg_or_args : [arg_or_args]);
  if (process.platform !== 'win32') { args.unshift('mono'); }
  return exec(args.join(' '));
};

const debounceCallback = function(callback) {
  var debounced_callback = function() { if (debounced_callback.was_called) { return; debounced_callback.was_called = true; return callback.apply(null, Array.prototype.slice.call(arguments, 0)); } };
  return debounced_callback;
};

const getFile = function(file, callback) {
  if (file.pipe) { return callback(null, file); }
  return vinyl.src(file)
    .pipe(es.writeArray(function(err, files) {
      if (err) { return callback(err); }
      if ((files.length === 0) || (files.length > 1)) { return callback(new Error(`Expecting one file for ${file}. Found ${files.length}`)); }
      return callback(null, files[0]);
    })
  );
};

const randomFilename = () => crypto.createHash('sha1').update(new Date().getTime().toString()+_.uniqueId()).digest('hex');

module.exports = NodeNuget = class NodeNuget {
  static setApiKey(key, callback) {
    if (runCommand('setApiKey', key).code !== 0) { return callback(new Error('Failed to set API key')); }
    return callback();
  }

  static pack(file, callback) {
    return getFile(file, function(err, file) {
      if (err) { return callback(err); }

      return file.pipe(es.wait(function(err, data) {
        let item, missing_files;
        if (err) { return callback(err); }

        const package_desc = et.parse(data.toString());
        const package_id = package_desc.findtext('./metadata/id');
        const package_version = package_desc.findtext('./metadata/version');

        const files = ((() => {
          const result = [];
          for (item of Array.from(package_desc.findall('./files/file'))) {
            result.push(path.join(path.dirname(file.path), item.attrib != null ? item.attrib.src : undefined));
          }
          return result;
        })());
        if ((missing_files = ((() => {
          const result1 = [];
          for (item of Array.from(file)) {             if (!fs.existsSync(item)) {
              result1.push(item);
            }
          }
          return result1;
        })())).length) {
          return callback(new Error(`Nuget: cannot build ${file.path}. Missing files: ${missing_files}`));
        }

        if (runCommand('pack', file.path).code !== 0) { return callback(new Error(`Failed to pack file: ${file.path}`)); }

        const package_path = path.resolve(path.join(process.cwd(), '.', `${package_id}.${package_version}.nupkg`));
        return getFile(package_path, function(err, file) {
          if (err) { return callback(err); }
          return fs.unlink(package_path, () => callback(err, file));
        });
      })
      );
    });
  }

  static push(file, callback) {
    let file_path = null; let owned = false;

    const queue = new Queue(1);

    // ensure there is a file on disk
    queue.defer(function(callback) {
      if (!file.pipe) { return callback(null, (file_path = file)); }
      if (fs.existsSync(file_path = file.path)) { return callback(); } // use if exists on disk

      callback = debounceCallback(callback);
      file_path = randomFilename(); owned = true;
      return file
        .pipe(fs.createWriteStream(file_path))
        .on('finish', callback)
        .on('error', callback);
    });

    // run push command
    queue.defer(function(callback) {
      if (runCommand('push', [file_path, '-Source', 'nuget.org', '-NonInteractive']).code !== 0) { return callback(new Error(`Failed to push file: ${file.path}`)); }
      return callback();
    });

    // clean up temp file if needed
    return queue.await(function(err) {
      if (file_path && owned && fs.existsSync(file_path)) { fs.unlinkSync(file_path); }
      return callback(err);
    });
  }
};
