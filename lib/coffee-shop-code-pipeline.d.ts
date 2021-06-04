import * as cdk from '@aws-cdk/core';
import * as ecr from '@aws-cdk/aws-ecr';
export declare class CoffeeShopCodePipeline extends cdk.Stack {
    readonly ecrRepository: ecr.Repository;
    constructor(scope: cdk.App, id: string, props?: cdk.StackProps);
}
