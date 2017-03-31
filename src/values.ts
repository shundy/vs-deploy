/// <reference types="node" />

// The MIT License (MIT)
// 
// vs-deploy (https://github.com/mkloubert/vs-deploy)
// Copyright (c) Marcel Joachim Kloubert <marcel.kloubert@gmx.net>
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import * as deploy_contracts from './contracts';
import * as deploy_globals from './globals';
import * as deploy_helpers from './helpers';
import * as FS from 'fs';
import * as OS from 'os';
import * as Path from 'path';
import * as vs_deploy from './deploy';
import * as vscode from 'vscode';


let globalScriptValueState: Object;
let scriptValueStates: Object;


/**
 * A basic value.
 */
export abstract class ValueBase implements deploy_contracts.ObjectWithNameAndValue {
    /**
     * Stores the underlying item.
     */
    protected readonly _ITEM: deploy_contracts.ValueWithName;

    /**
     * Initializes a new instance of that class.
     * 
     * @param {deploy_contracts.ValueWithName} [item] The underlying item.
     */
    constructor(item?: deploy_contracts.ValueWithName) {
        if (!item) {
            item = {
                name: undefined,
                type: undefined,
            };
        }
        
        this._ITEM = item;
    }

    /**
     * Anthing that identifies that value.
     */
    public id: any;

    /**
     * Gets the underlying item.
     */
    public get item(): deploy_contracts.ValueWithName {
        return this._ITEM;
    }

    /**
     * Gets the list of "other" values.
     */
    public get otherValues(): ValueBase[] {
        let result: ValueBase[] = [];

        let ovp = this.otherValueProvider;
        if (ovp) {
            try {
                result = result.concat(deploy_helpers.asArray(ovp()));
            }
            catch (e) {
                //TODO: log
            }
        }

        return result.filter(x => x);
    }

    /**
     * The function that provides the "other" values.
     */
    public otherValueProvider: () => ValueBase[];

    /** @inheritdoc */
    public get name(): string {
        return this.item.name;
    }

    /** @inheritdoc */
    public abstract get value(): any;
}

/**
 * A value generated by (JavaScript) code.
 */
export class CodeValue extends ValueBase {
    /** @inheritdoc */
    constructor(value?: deploy_contracts.CodeValueWithName) {
        super(value);
    }
    
    /** @inheritdoc */
    public get code(): string {
        return deploy_helpers.toStringSafe(this.item.code);
    }

    /**
     * Gets the underlying item.
     */
    public get item(): deploy_contracts.CodeValueWithName {
        return <deploy_contracts.CodeValueWithName>super.item;
    }

    /** @inheritdoc */
    public get value(): any {
        let $cwd = process.cwd();
        let $homeDir = OS.homedir();
        let $globalState = globalScriptValueState;
        let $me = this;
        let $others = {};
        let $require = function(id: string) {
            return require(deploy_helpers.toStringSafe(id));
        };
        let $workspaceRoot = vscode.workspace.rootPath;

        // define properties for $others
        this.otherValues.forEach(ov => {
            try {
                let propertyName = deploy_helpers.toStringSafe(ov.name);
                if ('' === propertyName) {
                    return;
                }

                Object.defineProperty($others, propertyName, {
                    enumerable: true,
                    configurable: true,

                    get: () => {
                        return ov.value;
                    }
                });
            }
            catch (e) {
                //TODO: log
            }
        });

        return eval(this.code);
    }
}

/**
 * A value that accesses an environment variable.
 */
export class EnvValue extends ValueBase {
    /** @inheritdoc */
    constructor(value?: deploy_contracts.EnvValueWithName) {
        super(value);
    }

    /** @inheritdoc */
    public get alias(): string {
        return this.item.alias;
    }

    /** @inheritdoc */
    public get name(): string {
        return deploy_helpers.isEmptyString(this.alias) ? this.realName
                                                        : this.alias;
    }

    /**
     * Gets the underlying item.
     */
    public get item(): deploy_contracts.EnvValueWithName {
        return <deploy_contracts.EnvValueWithName>super.item;
    }

    /** @inheritdoc */
    public get value(): any {
        let value: any;

        let myName = deploy_helpers.toStringSafe(this.realName).trim();

        for (let p in process.env) {
            if (deploy_helpers.toStringSafe(p).trim() === myName) {
                value = process.env[p];  // found
                break;
            }
        }

        return value;
    }

    /**
     * Gets the "real" name.
     */
    public get realName(): string {
        return super.name;
    }
}

/**
 * A value from a file.
 */
export class FileValue extends ValueBase {
    /** @inheritdoc */
    constructor(value?: deploy_contracts.FileValueWithName) {
        super(value);
    }

    /**
     * Gets the underlying item.
     */
    public get item(): deploy_contracts.FileValueWithName {
        return <deploy_contracts.FileValueWithName>super.item;
    }

    /** @inheritdoc */
    public get value(): any {
        let file = deploy_helpers.toStringSafe(this.item.file);
        file = replaceWithValues(this.otherValues, file);
        if (!Path.isAbsolute(file)) {
            file = Path.join(vscode.workspace.rootPath, file)
        }
        file = Path.resolve(file);

        let content = FS.readFileSync(file);
        
        if (content) {
            if (deploy_helpers.toBooleanSafe(this.item.asBinary)) {
                return content;
            }
            else {
                // as string

                let enc = deploy_helpers.normalizeString(this.item.encoding);
                if ('' === enc) {
                    enc = 'utf8';
                }

                let str = content.toString(enc);

                if (deploy_helpers.toBooleanSafe(this.item.usePlaceholders)) {
                    str = replaceWithValues(this.otherValues, str);
                }

                return str;
            }
        }

        return content;
    }
}

/**
 * A value provided by a script.
 */
export class ScriptValue extends ValueBase {
    protected _config: deploy_contracts.DeployConfiguration;

    /** @inheritdoc */
    constructor(value?: deploy_contracts.ScriptValueWithName,
                cfg?: deploy_contracts.DeployConfiguration) {
        super(value);

        this._config = cfg;
    }

    /**
     * Gets the underlying configuration.
     */
    public get config(): deploy_contracts.DeployConfiguration {
        return this._config || <any>{};
    }

    /**
     * Gets the underlying item.
     */
    public get item(): deploy_contracts.ScriptValueWithName {
        return <deploy_contracts.ScriptValueWithName>super.item;
    }

    /** @inheritdoc */
    public get value(): any {
        let me = this;

        let result: any;

        let script = deploy_helpers.toStringSafe(me.item.script);
        script = replaceWithValues(me.otherValues, script);

        if (!deploy_helpers.isEmptyString(script)) {
            if (!Path.isAbsolute(script)) {
                script = Path.join(vscode.workspace.rootPath, script);
            }
            script = Path.resolve(script);

            delete require.cache[script];
            if (FS.existsSync(script)) {
                let scriptModule = deploy_helpers.loadModule<deploy_contracts.ScriptValueModule>(script);
                if (scriptModule) {
                    if (scriptModule.getValue) {
                        let args: deploy_contracts.ScriptValueProviderArguments = {
                            emitGlobal: function() {
                                return deploy_globals.EVENTS.emit
                                                            .apply(deploy_globals.EVENTS, arguments);
                            },
                            globals: deploy_helpers.cloneObject(me.config.globals),
                            globalState: undefined,
                            name: undefined,
                            options: deploy_helpers.cloneObject(me.item.options),
                            others: undefined,
                            replaceWithValues: function(val) {
                                return replaceWithValues(me.otherValues, val);
                            },
                            require: (id) => {
                                return require(deploy_helpers.toStringSafe(id));
                            },
                            state: undefined,
                        };

                        let others: Object = {};
                        me.otherValues.forEach(ov => {
                            try {
                                let propertyName = deploy_helpers.toStringSafe(ov.name);
                                if ('' === propertyName) {
                                    return;
                                }

                                Object.defineProperty(others, propertyName, {
                                    enumerable: true,
                                    configurable: true,

                                    get: () => {
                                        return ov.value;
                                    }
                                });
                            }
                            catch (e) {
                                //TODO: log
                            }
                        });

                        // args.globalState
                        Object.defineProperty(args, 'globalState', {
                            enumerable: true,

                            get: () => {
                                return globalScriptValueState;
                            },
                        });

                        // args.name
                        Object.defineProperty(args, 'name', {
                            enumerable: true,

                            get: () => {
                                return me.name;
                            },
                        });

                        // args.others
                        Object.defineProperty(args, 'others', {
                            enumerable: true,

                            get: () => {
                                return others;
                            },
                        });

                        // args.state
                        Object.defineProperty(args, 'state', {
                            enumerable: true,

                            get: () => {
                                return scriptValueStates[script];
                            },
                            set: (newValue) => {
                                scriptValueStates[script] = newValue;
                            }
                        });

                        result = scriptModule.getValue(args);
                    }
                }
            }
        }

        return result;
    }
}

/**
 * A static value.
 */
export class StaticValue extends ValueBase {
    /** @inheritdoc */
    constructor(value?: deploy_contracts.StaticValueWithName) {
        super(value);
    }

    /**
     * Gets the underlying item.
     */
    public get item(): deploy_contracts.StaticValueWithName {
        return <deploy_contracts.StaticValueWithName>super.item;
    }

    /** @inheritdoc */
    public get value(): any {
        return this.item.value;
    }
}

/**
 * Gets the current list of values.
 * 
 * @return {ValueBase[]} The values.
 */
export function getValues(): ValueBase[] {
    let me: vs_deploy.Deployer = this;

    let myName = me.name;

    let values = deploy_helpers.asArray(me.config.values)
                               .filter(x => x);

    // isFor
    values = values.filter(v => {
        let validHosts = deploy_helpers.asArray(v.isFor)
                                       .map(x => deploy_helpers.normalizeString(x))
                                       .filter(x => '' !== x);

        if (validHosts.length < 1) {
            return true;
        }

        return validHosts.indexOf(myName) > -1;
    });

    // platforms
    values = deploy_helpers.filterPlatformItems(values);

    let objs = toValueObjects(values, me.config);

    // ${cwd}
    {
        objs.push(new CodeValue({
            name: 'cwd',
            type: "code",
            code: "process.cwd()",
        }));
    }

    // ${homeDir}
    {
        objs.push(new CodeValue({
            name: 'homeDir',
            type: "code",
            code: "require('os').homedir()",
        }));
    }

    // ${workspaceRoot}
    {
        objs.push(new CodeValue({
            name: 'workspaceRoot',
            type: "code",
            code: "require('vscode').workspace.rootPath",
        }));
    }

    return objs;
}

/**
 * Handles a value as string and replaces placeholders.
 * 
 * @param {ValueBase|ValueBase[]} values The "placeholders".
 * @param {any} val The value to parse.
 * 
 * @return {string} The parsed value.
 */
export function replaceWithValues(values: ValueBase | ValueBase[], val: any): string {
    let allValues = deploy_helpers.asArray(values).filter(x => x);

    if (!deploy_helpers.isNullOrUndefined(val)) {
        let str = deploy_helpers.toStringSafe(val);

        allValues.forEach(v => {
            let vn = deploy_helpers.normalizeString(v.name);

            // ${VAR_NAME}
            str = str.replace(/(\$)(\{)([^\}]*)(\})/gm, (match, varIdentifier, openBracket, varName: string, closedBracked) => {
                let newValue: string = match;

                if (deploy_helpers.normalizeString(varName) === vn) {
                    try {
                        newValue = deploy_helpers.toStringSafe(v.value);
                    }
                    catch (e) {
                        //TODO: log
                    }
                }

                return newValue;
            });
        });

        return str;
    }

    return val;
}

/**
 * Resets all code / script based state values and objects.
 */
export function resetScriptStates() {
    globalScriptValueState = {};
    scriptValueStates = {};
}

/**
 * Converts a list of value items to objects.
 * 
 * @param {(deploy_contracts.ValueWithName|deploy_contracts.ValueWithName[])} items The item(s) to convert.
 *  
 * @returns {ValueBase[]} The items as objects. 
 */
export function toValueObjects(items: deploy_contracts.ValueWithName | deploy_contracts.ValueWithName[],
                               cfg?: deploy_contracts.DeployConfiguration): ValueBase[] {
    let result: ValueBase[] = [];

    deploy_helpers.asArray(items).filter(i => i).forEach((i, idx) => {
        let newValue: ValueBase;
        
        switch (deploy_helpers.normalizeString(i.type)) {
            case '':
            case 'static':
                newValue = new StaticValue(<deploy_contracts.StaticValueWithName>i);
                break;

            case 'code':
                newValue = new CodeValue(<deploy_contracts.CodeValueWithName>i);
                break;

            case 'env':
            case 'environment':
                newValue = new EnvValue(<deploy_contracts.EnvValueWithName>i);
                break;

            case 'file':
                newValue = new FileValue(<deploy_contracts.FileValueWithName>i);
                break;

            case 'script':
                newValue = new ScriptValue(<deploy_contracts.ScriptValueWithName>i, cfg);
                break;
        }

        if (newValue) {
            newValue.id = idx;
            newValue.otherValueProvider = () => {
                return result.filter(x => x.id !== newValue.id);
            };

            result.push(newValue);
        }
    });

    return result;
}
