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

import * as deploy_contracts from '../contracts';
import * as deploy_helpers from '../helpers';
import * as deploy_objects from '../objects';
import * as FS from 'fs';
import * as HTTP from 'http';
const MIME = require('mime');
import * as Moment from 'moment';
import * as Path from 'path';
import * as URL from 'url';


const DATE_RFC2822_UTC = "ddd, DD MMM YYYY HH:mm:ss [GMT]";

interface DeployTargetHttp extends deploy_contracts.DeployTarget {
    headers?: { [key: string]: any };
    method?: string;
    password?: string;
    submitContentLength?: boolean;
    submitContentType?: boolean;
    submitDate?: boolean;
    submitFileHeader?: boolean;
    user?: string;
    url?: string;
}

function detectContentType(file: string): string {
    let mime: string;
    try {
        mime = MIME.lookup(file);
    }
    catch (e) {
        deploy_helpers.log(`[ERROR] http.detectContentType(): ${deploy_helpers.toStringSafe(e)}`);
    }

    mime = deploy_helpers.toStringSafe(mime).toLowerCase().trim();
    if (!mime) {
        mime = 'application/octet-stream';
    }

    return mime;
}

class HttpPlugin extends deploy_objects.DeployPluginBase {
    public deployFile(file: string, target: DeployTargetHttp, opts?: deploy_contracts.DeployFileOptions): void {
        let now = Moment().utc();

        if (!opts) {
            opts = {};
        }

        let me = this;

        let completed = (err?: any) => {
            if (opts.onCompleted) {
                opts.onCompleted(me, {
                    error: err,
                    file: file,
                    target: target,
                });
            }
        };

        let relativePath = deploy_helpers.toRelativePath(file);
        if (false === relativePath) {
            completed(new Error(`Cannot get relative path for '${file}'!`));
            return;
        }

        let url = deploy_helpers.toStringSafe(target.url).trim();
        if (!url) {
            url = 'http://localhost';
        }

        let method = deploy_helpers.toStringSafe(target.method).toUpperCase().trim();
        if (!method) {
            method = 'PUT';
        }

        let headers = target.headers;
        if (!headers) {
            headers = {};
        }

        let user = deploy_helpers.toStringSafe(target.user);
        if (user) {
            let pwd = deploy_helpers.toStringSafe(target.password);

            headers['Authorization'] = 'Basic ' + 
                                       (new Buffer(`${user}:${pwd}`)).toString('base64');
        }

        let submitFileHeader = deploy_helpers.toBooleanSafe(target.submitFileHeader, false);
        if (submitFileHeader) {
            headers['X-vsdeploy-file'] = relativePath;
        }

        let contentType = detectContentType(file);

        try {
            if (opts.onBeforeDeploy) {
                opts.onBeforeDeploy(me, {
                    file: file,
                    target: target,
                });
            }

            // get file info
            FS.lstat(file, (err, stats) => {
                if (err) {
                    completed(err);
                    return;
                }

                let creationTime = Moment(stats.birthtime).utc();
                let lastWriteTime = Moment(stats.mtime).utc();
            
                // read file
                FS.readFile(file, (err, data) => {
                    if (err) {
                        completed(err);
                        return;
                    }

                    try {
                        let parsePlaceHolders = (str: string, transformer?: (val: any) => string): string => {
                            if (!transformer) {
                                transformer = (s) => deploy_helpers.toStringSafe(s);
                            }

                            str = deploy_helpers.toStringSafe(str);

                            str = str.replace(/(\$)(\{)(vsdeploy\-date)(\})/i, transformer(now.format(DATE_RFC2822_UTC)));
                            str = str.replace(/(\$)(\{)(vsdeploy\-file)(\})/i, transformer(<string>relativePath));
                            str = str.replace(/(\$)(\{)(vsdeploy\-file\-mime)(\})/i, transformer(contentType));
                            str = str.replace(/(\$)(\{)(vsdeploy\-file\-name)(\})/i, transformer(Path.basename(file)));
                            str = str.replace(/(\$)(\{)(vsdeploy\-file\-size)(\})/i, transformer(data.length));
                            str = str.replace(/(\$)(\{)(vsdeploy\-file\-time-changed)(\})/i, transformer(lastWriteTime.format(DATE_RFC2822_UTC)));
                            str = str.replace(/(\$)(\{)(vsdeploy\-file\-time-created)(\})/i, transformer(creationTime.format(DATE_RFC2822_UTC)));

                            return deploy_helpers.toStringSafe(str);
                        };

                        let targetUrl = URL.parse(parsePlaceHolders(url, (str) => {
                            return encodeURIComponent(str);
                        }));

                        let submitContentLength = deploy_helpers.toBooleanSafe(target.submitContentLength, true);
                        if (submitContentLength) {
                            headers['Content-length'] = deploy_helpers.toStringSafe(data.length, '0');
                        }

                        let submitContentType = deploy_helpers.toBooleanSafe(target.submitContentType, true);
                        if (submitContentType) {
                            headers['Content-type'] = contentType;
                        }

                        let submitDate = deploy_helpers.toBooleanSafe(target.submitDate, true);
                        if (submitDate) {
                            headers['Date'] = now.format(DATE_RFC2822_UTC);  // RFC 2822
                        }

                        let headersToSubmit = {};
                        for (let p in headers) {
                            headersToSubmit[p] = parsePlaceHolders(headers[p]);
                        }

                        let protocol = deploy_helpers.toStringSafe(targetUrl.protocol).toLowerCase().trim();
                        if (!protocol) {
                            protocol = 'http:';
                        }

                        switch (protocol) {
                            case 'http:':
                            case 'https:':
                                // supported protocols
                                break;

                            default:
                                completed(new Error(`Protocol ${protocol} is not supported!`));
                                return;
                        }

                        let hostName = deploy_helpers.toStringSafe(targetUrl.hostname).toLowerCase().trim();
                        if (!hostName) {
                            hostName = 'localhost';
                        }

                        let port = deploy_helpers.toStringSafe(targetUrl.port).trim();
                        if (!port) {
                            port = 'http:' == protocol ? '80' : '443';
                        }

                        // start the request
                        let req = HTTP.request({
                            headers: headersToSubmit,
                            host: hostName,
                            method: method,
                            path: targetUrl.path,
                            port: parseInt(port),
                            protocol: protocol,
                        }, (resp) => {
                            if (!(resp.statusCode > 199 && resp.statusCode < 300)) {
                                completed(new Error(`No success: [${resp.statusCode}] '${resp.statusMessage}'`));
                                return;
                            }

                            if (resp.statusCode > 399 && resp.statusCode < 500) {
                                completed(new Error(`Client error: [${resp.statusCode}] '${resp.statusMessage}'`));
                                return;
                            }

                            if (resp.statusCode > 499 && resp.statusCode < 600) {
                                completed(new Error(`Server error: [${resp.statusCode}] '${resp.statusMessage}'`));
                                return;
                            }

                            if (resp.statusCode > 599) {
                                completed(new Error(`Error: [${resp.statusCode}] '${resp.statusMessage}'`));
                                return;
                            }

                            completed();
                        });

                        req.once('error', (err) => {
                            if (err) {
                                completed(err);
                            }
                        });

                        // send file content
                        req.write(data);

                        req.end();
                    }
                    catch (e) {
                        completed(e);
                    }
                });
            });
        }
        catch (e) {
            completed(e);
        }
    }

    public info(): deploy_contracts.DeployPluginInfo {
        return {
            description: 'Deploys to a HTTP server/service',
        }
    }
}

/**
 * Creates a new Plugin.
 * 
 * @param {deploy_contracts.DeployContext} ctx The deploy context.
 * 
 * @returns {deploy_contracts.DeployPlugin} The new instance.
 */
export function createPlugin(ctx: deploy_contracts.DeployContext): deploy_contracts.DeployPlugin {
    return new HttpPlugin(ctx);
}