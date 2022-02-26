#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ElasticBeanstalkCdkStack, ElasticBeanstalkCdkStackProps } from '../lib/elastic_beanstalk_cdk_project-stack';

const app = new cdk.App();
const settings: ElasticBeanstalkCdkStackProps = app.node.tryGetContext('configuration')

new ElasticBeanstalkCdkStack(app, 'ElasticBeanstalkCdkStack', settings);