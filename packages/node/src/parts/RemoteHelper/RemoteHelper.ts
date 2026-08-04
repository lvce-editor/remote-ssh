// cspell:disable
export const source = String.raw`
import base64
import json
import os
import shutil
import sys

MARKER = '__LVCE_REMOTE_SSH__'
DIRECTORY_TYPE = 3
FILE_TYPE = 7

def respond(result=None, error=None, code=None):
    value = {'ok': error is None}
    if error is None:
        value['result'] = result
    else:
        value['error'] = error
        value['code'] = code
    print(MARKER + json.dumps(value, ensure_ascii=False))

def require_mutable(path):
    if os.path.normpath(path) == os.path.sep:
        raise PermissionError('Cannot modify the remote root folder')

def execute(request):
    operation = request['operation']
    path = request['path']
    if operation == 'connect':
        if not os.path.isdir(path):
            raise NotADirectoryError(path)
        return None
    if operation == 'readDirWithFileTypes':
        entries = []
        with os.scandir(path) as iterator:
            for entry in iterator:
                entry_type = DIRECTORY_TYPE if entry.is_dir() else FILE_TYPE
                entries.append({'name': entry.name, 'type': entry_type})
        entries.sort(key=lambda entry: entry['name'])
        return entries
    if operation == 'readFile':
        with open(path, 'rb') as file:
            return base64.b64encode(file.read()).decode('ascii')
    if operation == 'writeFile':
        require_mutable(path)
        content = base64.b64decode(request['content'])
        with open(path, 'wb') as file:
            file.write(content)
        return None
    if operation == 'mkdir':
        require_mutable(path)
        os.mkdir(path)
        return None
    if operation == 'remove':
        require_mutable(path)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        return None
    if operation == 'rename':
        new_path = request['newPath']
        require_mutable(path)
        require_mutable(new_path)
        if not os.path.lexists(path):
            raise FileNotFoundError(path)
        if os.path.lexists(new_path):
            raise FileExistsError(new_path)
        os.rename(path, new_path)
        return None
    raise ValueError('Unknown Remote SSH operation: ' + operation)

try:
    request = json.load(sys.stdin)
    respond(execute(request))
except Exception as error:
    code = getattr(error, 'errno', None)
    respond(error=type(error).__name__ + ': ' + str(error), code=code)
`

export const marker = '__LVCE_REMOTE_SSH__'

const encodedSource = Buffer.from(source).toString('base64')

export const command = `python3 -c "import base64;exec(base64.b64decode('${encodedSource}'))"`
